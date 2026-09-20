# Humline native · 0.1.0

A microphone-to-MIDI audio effect with a native piano roll and a small sine synth.
It captures one pitch at a time. Edit the notes, audition them, save a MIDI file,
or route its MIDI output to another instrument where the DAW permits.

## Install and use

For the Linux x86-64 build, copy the whole `Humline.vst3` folder to your user's
`~/.vst3/` directory and rescan plug-ins in your DAW. The standalone `Humline`
executable also runs directly; select an audio input/output device in its audio
settings. The prebuilt package targets Ubuntu 24.04 or compatible Linux.

1. Insert Humline as an **audio effect** on a microphone track. Feed voice to
   input channel 1 (mono or stereo input is accepted). Enable input monitoring
   so audio reaches the plug-in.
2. Set the clip tempo and press **Record voice** inside Humline. It records into
   its own clip independently of the DAW transport. Press **Stop recording**.
3. Drag notes, resize their right edge, or use Pitch, Start, Length, and Velocity.
   Double-click empty space to add a note. **Undo** restores earlier edits.
4. Press **Play** to audition, or **Export MIDI** and import that file onto an
   instrument track in your DAW.
5. For live MIDI, send Humline's MIDI output to a separate instrument track
   using the DAW's routing controls. Support differs between hosts.

Humline suppresses microphone audio at its output. **Synth monitor** plays
detected MIDI through the built-in synth; use headphones to prevent its output
being picked up by the microphone. The standalone app uses its audio settings
for microphone selection.

## Formats and current boundaries

- CMake builds **VST3** and **Standalone** on Linux, Windows, and macOS; macOS also
  has an **AU** target. Only Linux binaries are built in this project session.
- AU, Windows, macOS, and real DAW compatibility are not yet validated. No AAX
  or CLAP target is included. Some hosts do not route MIDI from audio effects;
  importing exported MIDI is the common fallback.
- Native captures use a 65–1,000 Hz range and separate repeated note attacks.
- Native MIDI import flattens tempo changes to the first tempo while preserving
  elapsed note timing. Native export contains notes and one tempo; controllers,
  track layout, and other metadata are not preserved.
- Clips are limited to 4,096 notes or 10 minutes per recording. The native grid
  snaps edits to quarter beats; the inspector supports finer values.
- DAW session state includes parameters and the clip. Host transport sync,
  latency compensation, pitch bend output, polyphony, and continuous expression
  output are not included.
- The sine synth voices are keyed by pitch: overlapping identical pitches on
  separate channels can interact in its audio output. MIDI retains channels.

## Build

Use CMake 3.24+ and a C++17 compiler. CMake downloads a hash-pinned JUCE 9.0.2
archive from the official `juce-framework/JUCE` repository.

```sh
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --config Release --parallel 2
ctest --test-dir build/native -C Release --output-on-failure
```

Output is under `build/native/Humline_artefacts/Release/`. On Windows use Visual
Studio's C++ toolchain; on macOS use Xcode's command-line tools.

Ubuntu prerequisites include `build-essential`, `cmake`, `pkg-config`,
`libasound2-dev`, `libfreetype-dev`, `libfontconfig-dev`, `libx11-dev`, `libxext-dev`,
`libxrandr-dev`, `libxinerama-dev`, `libxcursor-dev`, `libxi-dev`, and `libgl-dev`.
WebKit and libcurl are disabled; the editor does not need an embedded browser.

To use an already-extracted JUCE tree, add
`-DFETCHCONTENT_SOURCE_DIR_JUCE=/absolute/path/to/JUCE` when configuring.
The source download includes the matching upstream JUCE tree.

To test just the detector without JUCE:

```sh
cmake -S native -B build/detector -DHUMLINE_BUILD_PLUGIN=OFF
cmake --build build/detector
ctest --test-dir build/detector --output-on-failure
```

## Dependencies

The bundled native build uses JUCE under its AGPLv3 option. The web studio’s **Source** download includes the matching Humline and
upstream JUCE source; the complete Linux package provided in chat includes both. See `THIRD_PARTY.md` and
`LICENSE-AGPL-3.0.txt` for license text and dependency details.
