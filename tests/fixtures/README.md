# 音频测试夹具

`voice.mp3` 是本地生成的 440 Hz 纯音，采样率 24 kHz、单声道、码率 48 kbit/s，不含录音、语音或外部音频。它用于模拟 Edge TTS 输出，验证 MP3 解码、重采样、AMR 编码调用和临时文件清理。

在仓库根目录可用以下命令重新生成：

```bash
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i 'sine=frequency=440:sample_rate=24000:duration=1' \
  -ac 1 -codec:a libmp3lame -b:a 48k \
  -map_metadata -1 -write_xing 0 -id3v2_version 0 \
  -y tests/fixtures/voice.mp3
```

ffmpeg 仅用于重新生成夹具，运行 Driver 或自动测试不需要安装它。
