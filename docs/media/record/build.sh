#!/bin/zsh
# Cut the README clips out of the recorded takes.
#
# Usage: build.sh TOUR_MP4 LESSONS_MP4 TASKS_MP4
#
# The cut points below match the takes the committed clips came from; a new
# recording runs at its own pace, so check its frames and move them.
# Writes into docs/media: animated WebP (img2webp, lossy q70) and the hero mp4.
set -euo pipefail
REC=${0:A:h}
OUT=${REC:h}
TOUR=${1:?usage: build.sh TOUR_MP4 LESSONS_MP4 TASKS_MP4}
LESSONS=${2:?usage: build.sh TOUR_MP4 LESSONS_MP4 TASKS_MP4}
TASKS=${3:?usage: build.sh TOUR_MP4 LESSONS_MP4 TASKS_MP4}
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

# the jarvis pane inside a 1400x820 take
PANE=630:745:770:8

# clip NAME SRC CROP WIDTH FPS SEG...
# Each SEG is START:END:SPEED in seconds of SRC (SPEED > 1 plays faster); the
# segments are joined in order. CROP is w:h:x:y, or "full".
clip() {
  local name=$1 src=$2 crop=$3 width=$4 fps=$5; shift 5
  local dir=$TMP/$name seg start end speed vf n=1
  mkdir -p "$dir"
  for seg in "$@"; do
    IFS=: read -r start end speed <<< "$seg"
    vf="setpts=PTS/${speed},fps=${fps},scale=${width}:-2:flags=lanczos"
    [[ $crop == full ]] || vf="crop=${crop},$vf"
    ffmpeg -loglevel error -y -ss "$start" -to "$end" -i "$src" -vf "$vf" -start_number $n "$dir/f%05d.png"
    n=$(( $(ls "$dir" | wc -l) + 1 ))
  done
  img2webp -loop 0 -lossy -q 70 -m 6 -d $(( 1000 / fps )) "$dir"/f*.png -o "$OUT/$name.webp" >/dev/null
  echo "$OUT/$name.webp: $(ls "$dir" | wc -l | tr -d ' ') frames"
}

# the hero tour, also as an mp4 for the "Watch the full tour" link
hero() {
  clip hero-tour "$TOUR" full 1200 12 "${HERO[@]}"
  ffmpeg -loglevel error -y -framerate 12 -i "$TMP/hero-tour/f%05d.png" \
    -c:v libx264 -pix_fmt yuv420p -crf 22 -preset slow -movflags +faststart "$OUT/hero-tour.mp4"
  echo "$OUT/hero-tour.mp4"
}

# cut points, as START:END:SPEED
HERO=(4:12:2.5 12:32:6 32:126:8 402:442:3.2)
hero
clip now     "$TOUR"    $PANE 630 12 32:66:3.4
clip changes "$TOUR"    $PANE 630 12 411:424:1.2
clip stats   "$TOUR"    $PANE 630 12 424:435.4:1
clip tasks   "$TASKS"   630:330:770:8 630 12 12:46:3
clip lessons "$LESSONS" 1400:745:0:8 900 12 8:17:1.2 17:60:8
