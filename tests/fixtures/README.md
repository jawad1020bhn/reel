# UI test fixtures

`clip.webm` is a synthetic, silent 32-second, 160×90 VP8 colour plate (about
11 KB), generated for seeking/playback tests. It contains no user media and
requires no external CDN or account. Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i 'color=c=0x26394b:s=160x90:r=10:d=32' \
  -an -c:v libvpx -b:v 40k -g 10 -y tests/fixtures/clip.webm
```

The test server supplies an in-memory XReels export and an SVG poster. These
fixtures never replace `data/x-posts.json`, `data/posts.js`, or browser storage in
a normal browsing session. Each test uses a fresh browser context. The file-URL
smoke test injects the fixture into that test page only.
