# Generated downloads

The release archives are generated artifacts and are not stored in Git. Download
the current Linux build and corresponding source from the links in the root
README, or generate fresh archives after a successful native build:

```sh
python3 scripts/package-native.py \
  --build build/native \
  --juce build/native/_deps/juce-src \
  --output public/downloads
```
