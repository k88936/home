# Video

## search resource

https://www.jnqinghao.com/byersc/-------------.html?wd={KEYWORD}

use `playwright-cli open ${url} --browser chromium`to search, and nav to the play page and get the m3u8 (for episode need for each)

## filter ads and download

filter ads
```shell
n-m3u8 "https://example.com/hls/master.m3u8" \
  -f '/ads/' -f '/adjump/'\
  -o movie.m3u8 --print-command
```
and read the cmd tip to download the video

