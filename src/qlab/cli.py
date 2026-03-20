#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import mimetypes
import shutil
import threading
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse


SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".bmp",
    ".avif",
}


INDEX_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Image Annotator</title>
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/static/app.js"></script>
  </body>
</html>
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class ImageEntry:
    image_id: str
    name: str
    path: Path

    def payload(self) -> dict[str, str]:
        return {
            "id": self.image_id,
            "name": self.name,
            "url": f"/images/{quote(self.image_id, safe='/')}",
        }


class AnnotationStore:
    def __init__(self, image_dir: Path, output_path: Path) -> None:
        self.image_dir = image_dir
        self.output_path = output_path
        self.images = self._discover_images()
        self.images_by_id = {image.image_id: image for image in self.images}
        self.lock = threading.Lock()
        self.annotations = self._load_annotations()

    def _discover_images(self) -> list[ImageEntry]:
        images = []
        for path in sorted(
            self.image_dir.rglob("*"),
            key=lambda item: item.relative_to(self.image_dir).as_posix().lower(),
        ):
            if not path.is_file():
                continue
            if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            if path.name.startswith("._"):
                continue
            relative = path.relative_to(self.image_dir).as_posix()
            if relative.startswith("_qlab/"):
                continue
            images.append(ImageEntry(image_id=relative, name=relative, path=path))
        if not images:
            raise SystemExit(f"No supported images found under {self.image_dir}")
        return images

    def _load_annotations(self) -> dict[str, dict[str, Any]]:
        annotations: dict[str, dict[str, Any]] = {}
        if not self.output_path.exists():
            return annotations

        with self.output_path.open("r", encoding="utf-8") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise SystemExit(
                        f"Invalid JSON on line {line_number} of {self.output_path}: {exc}"
                    ) from exc
                image_id = str(record.get("image") or "")
                if image_id in self.images_by_id:
                    try:
                        annotations[image_id] = self._normalize_record(image_id, record)
                    except ValueError as exc:
                        raise SystemExit(
                            f"Invalid annotation on line {line_number} of {self.output_path}: {exc}"
                        ) from exc
        return annotations

    def state_payload(self) -> dict[str, Any]:
        with self.lock:
            annotations = dict(self.annotations)
        return {
            "images": [image.payload() for image in self.images],
            "annotations": annotations,
            "output_file": str(self.output_path),
        }

    def image_path(self, image_id: str) -> Path:
        image = self.images_by_id.get(image_id)
        if image is None:
            raise KeyError(image_id)
        return image.path

    def save(self, image_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if image_id not in self.images_by_id:
            raise KeyError(image_id)

        legacy_annotation = str(payload.get("annotation") or "")
        bboxes = self._coerce_bboxes(
            payload.get("bboxes", payload.get("bbox")),
            default_annotation=legacy_annotation,
        )
        redactions = self._coerce_redactions(payload.get("redactions"))
        image_size = self._coerce_image_size(payload.get("image_size"))

        with self.lock:
            if not bboxes and not redactions:
                self.annotations.pop(image_id, None)
                self._flush()
                self._remove_redacted(image_id)
                return None

            record = {
                "image": image_id,
                "bboxes": bboxes,
                "redactions": redactions,
                "image_size": image_size,
                "updated_at": utc_now(),
            }
            self.annotations[image_id] = record
            self._flush()

            if redactions:
                self._write_redacted_image(image_id, redactions)
            else:
                self._remove_redacted(image_id)

            return record

    def _normalize_record(self, image_id: str, record: dict[str, Any]) -> dict[str, Any]:
        legacy_annotation = str(record.get("annotation") or "")
        return {
            "image": image_id,
            "bboxes": self._coerce_bboxes(
                record.get("bboxes", record.get("bbox")),
                default_annotation=legacy_annotation,
            ),
            "redactions": self._coerce_redactions(record.get("redactions")),
            "image_size": self._coerce_image_size(record.get("image_size")),
            "updated_at": str(record.get("updated_at") or "") or None,
        }

    def _flush(self) -> None:
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.output_path.with_suffix(self.output_path.suffix + ".tmp")
        with temp_path.open("w", encoding="utf-8") as handle:
            for image in self.images:
                record = self.annotations.get(image.image_id)
                if record is None:
                    continue
                handle.write(json.dumps(record, ensure_ascii=False))
                handle.write("\n")
        temp_path.replace(self.output_path)

    @staticmethod
    def _coerce_box(raw_box: Any, default_annotation: str = "") -> dict[str, Any]:
        if not isinstance(raw_box, dict):
            raise ValueError("each bounding box must be an object")

        bbox: dict[str, Any] = {}
        for key in ("x", "y", "width", "height"):
            value = raw_box.get(key)
            if not isinstance(value, (int, float)):
                raise ValueError(f"bounding_box.{key} must be numeric")
            bbox[key] = round(float(value), 3)

        if bbox["width"] <= 0 or bbox["height"] <= 0:
            raise ValueError("bounding box width and height must be positive")
        annotation_value = raw_box.get("annotation") if "annotation" in raw_box else default_annotation
        bbox["annotation"] = "" if annotation_value is None else str(annotation_value)
        return bbox

    @classmethod
    def _coerce_bboxes(cls, raw_bboxes: Any, default_annotation: str = "") -> list[dict[str, Any]]:
        if raw_bboxes in (None, "", {}, []):
            return []
        if isinstance(raw_bboxes, dict):
            return [cls._coerce_box(raw_bboxes, default_annotation=default_annotation)]
        if not isinstance(raw_bboxes, list):
            raise ValueError("bboxes must be an array, object, or null")

        return [cls._coerce_box(raw_box, default_annotation=default_annotation) for raw_box in raw_bboxes]

    def _write_redacted_image(self, image_id: str, redactions: list[dict[str, Any]]) -> Path:
        from PIL import Image, ImageDraw  # lazy import

        src_path = self.images_by_id[image_id].path
        img = Image.open(src_path)
        img = img.convert("RGB")
        draw = ImageDraw.Draw(img)
        for box in redactions:
            x0 = box["x"]
            y0 = box["y"]
            x1 = x0 + box["width"]
            y1 = y0 + box["height"]
            draw.rectangle([x0, y0, x1, y1], fill=(255, 255, 255))

        dest = self.image_dir / "_qlab" / "redacted" / image_id
        dest.parent.mkdir(parents=True, exist_ok=True)
        img.save(dest)
        return dest

    def _remove_redacted(self, image_id: str) -> None:
        dest = self.image_dir / "_qlab" / "redacted" / image_id
        if dest.exists():
            dest.unlink()

    @staticmethod
    def _coerce_redaction_box(raw_box: Any) -> dict[str, Any]:
        if not isinstance(raw_box, dict):
            raise ValueError("each redaction box must be an object")
        bbox: dict[str, Any] = {}
        for key in ("x", "y", "width", "height"):
            value = raw_box.get(key)
            if not isinstance(value, (int, float)):
                raise ValueError(f"redaction_box.{key} must be numeric")
            bbox[key] = round(float(value), 3)
        if bbox["width"] <= 0 or bbox["height"] <= 0:
            raise ValueError("redaction box width and height must be positive")
        return bbox

    @classmethod
    def _coerce_redactions(cls, raw_redactions: Any) -> list[dict[str, Any]]:
        if raw_redactions in (None, "", {}, []):
            return []
        if not isinstance(raw_redactions, list):
            raise ValueError("redactions must be an array or null")
        return [cls._coerce_redaction_box(b) for b in raw_redactions]

    @staticmethod
    def _coerce_image_size(raw_size: Any) -> dict[str, int] | None:
        if raw_size in (None, "", {}):
            return None
        if not isinstance(raw_size, dict):
            raise ValueError("image_size must be an object or null")

        size = {}
        for key in ("width", "height"):
            value = raw_size.get(key)
            if not isinstance(value, (int, float)):
                raise ValueError(f"image_size.{key} must be numeric")
            size[key] = int(round(float(value)))
            if size[key] <= 0:
                raise ValueError(f"image_size.{key} must be positive")
        return size


def build_handler(store: AnnotationStore, static_dir: Path) -> type[BaseHTTPRequestHandler]:
    class AnnotatorHandler(BaseHTTPRequestHandler):
        server_version = "ImageAnnotator/1.0"

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path

            if path == "/" or path == "/index.html":
                self._send_html(INDEX_HTML)
                return

            if path == "/api/state":
                self._send_json(store.state_payload())
                return

            if path.startswith("/images/"):
                image_id = unquote(path.removeprefix("/images/"))
                self._serve_image(image_id)
                return

            if path.startswith("/static/"):
                asset_name = path.removeprefix("/static/")
                self._serve_static(asset_name)
                return

            if path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return

            self.send_error(HTTPStatus.NOT_FOUND, "Not found")

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path

            if not path.startswith("/api/annotations/"):
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return

            image_id = unquote(path.removeprefix("/api/annotations/"))
            content_length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
                record = store.save(image_id, payload)
            except json.JSONDecodeError:
                self.send_error(HTTPStatus.BAD_REQUEST, "Request body must be valid JSON")
                return
            except KeyError:
                self.send_error(HTTPStatus.NOT_FOUND, "Unknown image id")
                return
            except ValueError as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            self._send_json({"ok": True, "record": record})

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _serve_static(self, asset_name: str) -> None:
            # Static assets are limited to direct children of the static directory.
            asset_path = (static_dir / asset_name).resolve()
            if asset_path.parent != static_dir.resolve() or not asset_path.exists():
                self.send_error(HTTPStatus.NOT_FOUND, "Static asset not found")
                return

            content_type = mimetypes.guess_type(asset_path.name)[0] or "application/octet-stream"
            self._stream_file(asset_path, content_type)

        def _serve_image(self, image_id: str) -> None:
            try:
                image_path = store.image_path(image_id)
            except KeyError:
                self.send_error(HTTPStatus.NOT_FOUND, "Image not found")
                return

            content_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
            self._stream_file(image_path, content_type)

        def _stream_file(self, path: Path, content_type: str) -> None:
            try:
                stat = path.stat()
                with path.open("rb") as handle:
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(stat.st_size))
                    self.end_headers()
                    shutil.copyfileobj(handle, self.wfile)
            except FileNotFoundError:
                self.send_error(HTTPStatus.NOT_FOUND, "File not found")

        def _send_html(self, html: str, status: HTTPStatus = HTTPStatus.OK) -> None:
            payload = html.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _send_json(self, data: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return AnnotatorHandler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Launch a local browser UI for drawing one or more bounding boxes with per-box text annotations."
    )
    parser.add_argument("image_dir", help="Directory containing images to annotate")
    parser.add_argument(
        "--output",
        help="Destination JSONL file (default: IMAGE_DIR/annotations.jsonl)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind")
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Port to bind (default: 0, which picks a free port)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Start the server without opening a browser automatically",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    image_dir = Path(args.image_dir).expanduser().resolve()
    if not image_dir.is_dir():
        raise SystemExit(f"Image directory does not exist: {image_dir}")

    output_path = Path(args.output).expanduser().resolve() if args.output else image_dir / "_qlab" / "annotations.jsonl"
    static_dir = Path(__file__).resolve().parent / "static"
    required_assets = [static_dir / "app.css", static_dir / "app.js"]
    missing_assets = [str(path) for path in required_assets if not path.exists()]
    if missing_assets:
        missing = ", ".join(missing_assets)
        raise SystemExit(f"Missing static assets: {missing}")

    store = AnnotationStore(image_dir=image_dir, output_path=output_path)
    handler = build_handler(store, static_dir)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    host, port = server.server_address
    open_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{open_host}:{port}/"

    print(f"Serving {len(store.images)} images from {image_dir}")
    print(f"Writing annotations to {output_path}")
    print(f"Open {url}")

    if not args.no_browser:
        threading.Timer(0.25, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
