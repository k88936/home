---
name: media-resource
description: download video, episode...  resource from network
---

# Video/Episode

## search resource

https://www.jnqinghao.com/byersc/-------------.html?wd={KEYWORD}

use `playwright-cli open ${url} --browser chromium`to search, and nav to the play page and get the m3u8
[script](references/m3u8-probe.js)

## download

recommend use yt-dlp for parallel download
```shell
yt-dlp -N 16 --retries 50 --fragment-retries 50 -f "bv*+ba/b" --merge-output-format mp4 {URL}
```