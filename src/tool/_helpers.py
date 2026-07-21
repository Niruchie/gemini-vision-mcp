import base64
import mimetypes
from pathlib import Path


def detect_mime(path: Path, media_type: str) -> str:
	ext_map = {
		"image": {
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".png": "image/png",
			".webp": "image/webp",
			".gif": "image/gif",
			".bmp": "image/bmp",
		},
		"audio": {
			".mp3": "audio/mpeg",
			".wav": "audio/wav",
			".ogg": "audio/ogg",
			".flac": "audio/flac",
			".m4a": "audio/mp4",
		},
		"video": {
			".mp4": "video/mp4",
			".webm": "video/webm",
			".avi": "video/x-msvideo",
			".mov": "video/quicktime",
			".mkv": "video/x-matroska",
		},
	}
	defaults = {
		"image": "image/jpeg",
		"audio": "audio/mpeg",
		"video": "video/mp4",
		"text": "text/plain",
	}

	if path.suffix.lower() in ext_map.get(media_type, {}):
		return ext_map[media_type][path.suffix.lower()]

	guessed, _ = mimetypes.guess_type(path.name)
	if guessed and guessed.startswith(media_type):
		return guessed

	return defaults.get(media_type, "application/octet-stream")


def decode_b64(data: str) -> tuple[str, str]:
	if data.startswith("data:"):
		header, b64 = data.split(",", 1)
		mime = header.split(":")[1].split(";")[0]
		return b64, mime
	if data.startswith("/9j/"):
		return data, "image/jpeg"
	if data.startswith("iVBOR"):
		return data, "image/png"
	if data.startswith("UklGR"):
		return data, "image/webp"
	return data, "image/jpeg"


def file_to_image_dict(path: Path, media_type: str) -> dict:
	if media_type == "text":
		text = path.read_text(encoding="utf-8", errors="replace")
		return {"data": base64.b64encode(text.encode()).decode(), "mime_type": "text/plain"}
	mime = detect_mime(path, media_type)
	b64 = base64.b64encode(path.read_bytes()).decode()
	return {"data": b64, "mime_type": mime}
