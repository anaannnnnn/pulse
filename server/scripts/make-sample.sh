#!/usr/bin/env bash
# Generates the demo sample video, thumbnail and subtitle (requires ffmpeg).
set -euo pipefail
OUT=${1:-../data-demo}
mkdir -p "$OUT"
if [ ! -f "$OUT/sample.mp4" ]; then
  ffmpeg -loglevel error -y -f lavfi -i "gradients=s=1280x720:c0=0xE00A63:c1=0x7444FF:c2=0x1FD3E2:c3=0x0A0912:nb_colors=4:speed=0.015:d=60:r=30" \
    -f lavfi -i "sine=frequency=220:sample_rate=48000:d=60" -filter:a "volume=0.04" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -profile:v high -movflags +faststart -c:a aac -b:a 96k -shortest "$OUT/sample.mp4"
fi
[ -f "$OUT/thumb.jpg" ] || ffmpeg -loglevel error -y -ss 7 -i "$OUT/sample.mp4" -frames:v 1 -vf scale=640:360 "$OUT/thumb.jpg"
cat > "$OUT/sample.srt" <<'S'
1
00:00:01,000 --> 00:00:05,000
Subtitles load from sidecar .srt files next to the video.

2
00:00:06,000 --> 00:00:10,000
They are converted to WebVTT by the Pulse server.
S
echo "sample media in $OUT"
