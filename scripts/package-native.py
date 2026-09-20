"""Package an already-tested Linux build and its corresponding source.

python3 scripts/package-native.py --build build/native --juce /path/to/JUCE
"""
from pathlib import Path
import argparse
import hashlib
import shutil
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--build', type=Path, required=True)
parser.add_argument('--juce', type=Path, required=True)
parser.add_argument('--output', type=Path)
parser.add_argument('--complete', type=Path)
args = parser.parse_args()
project = Path(__file__).resolve().parents[1]
output = args.output or project / 'public/downloads'
output.mkdir(parents=True, exist_ok=True)
build = args.build / 'Humline_artefacts/Release'
assert (args.juce / 'CMakeLists.txt').is_file(), 'JUCE source is required'
assert (build / 'Standalone/Humline').is_file(), 'Build the native targets first'

source_zip = output / 'Humline-native-source.zip'
with zipfile.ZipFile(source_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    files = list((project / 'native').glob('*'))
    files += [project / 'tests/tracker-native.cpp', project / 'tests/processor-native.cpp', Path(__file__).resolve()]
    for path in sorted(files):
        if path.is_file(): archive.write(path, Path('Humline') / path.relative_to(project))
    for path in sorted(args.juce.rglob('*')):
        relative = path.relative_to(args.juce)
        needed = len(relative.parts) == 1 or relative.parts[0] in ('modules', 'docs') or relative.parts[:2] == ('extras', 'Build')
        if path.is_file() and needed and '.git' not in path.parts:
            archive.write(path, Path('Humline/third_party/JUCE') / relative)

source_hash = hashlib.sha256(source_zip.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='humline-package-') as temporary:
    stage = Path(temporary) / 'Humline-Linux-x86_64'
    stage.mkdir()
    shutil.copytree(build / 'VST3/Humline.vst3', stage / 'Humline.vst3')
    shutil.copy2(build / 'Standalone/Humline', stage / 'Humline')
    for binary in [stage / 'Humline', stage / 'Humline.vst3/Contents/x86_64-linux/Humline.so']:
        subprocess.run(['strip', '--strip-unneeded', str(binary)], check=True)
    for name in ['README.md', 'THIRD_PARTY.md', 'LICENSE-AGPL-3.0.txt']:
        shutil.copy2(project / 'native' / name, stage / name)
    (stage / 'SOURCE.txt').write_text(
        'Matching source: Humline-native-source.zip\n'
        'Use the Source link in the Humline web studio, or the included source ZIP in the complete package.\n'
        f'Source ZIP SHA-256: {source_hash}\n'
    )
    binary_zip = output / 'Humline-Linux-x86_64.zip'
    with zipfile.ZipFile(binary_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(stage.rglob('*')):
            if path.is_file(): archive.write(path, path.relative_to(stage.parent))
    if args.complete:
        args.complete.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(args.complete, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(stage.rglob('*')):
                if path.is_file(): archive.write(path, path.relative_to(stage.parent))
            archive.write(source_zip, 'Humline-Linux-x86_64/source/Humline-native-source.zip', compress_type=zipfile.ZIP_STORED)

for path in [source_zip, binary_zip] + ([args.complete] if args.complete else []):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, f'Corrupt archive: {path}'
    print(path.name, path.stat().st_size, 'bytes')
assert source_zip.stat().st_size < 25 * 1024 * 1024, 'Source download exceeds the per-asset hosting limit'
