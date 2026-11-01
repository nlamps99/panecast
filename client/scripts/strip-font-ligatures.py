#!/usr/bin/env python3
"""Remove ligatures from a font so a terminal shows every character as typed.

GeistMono's `liga` feature turns `...` into an ellipsis and `->`, `=>`, `|>`
into arrows. React Native on iOS (Fabric) cannot switch ligatures off with
`fontVariant`, so the bundled fonts in assets/fonts/ ship without them.

    pip3 install fonttools
    python3 scripts/strip-font-ligatures.py <in.ttf> <out.ttf>

Only the `liga`, `dlig` and `calt` feature records are removed from GSUB;
glyphs, metrics and every other feature stay. GeistMono is under the SIL
OFL 1.1 with no Reserved Font Name, so a modified copy may keep the name.
"""
import sys

from fontTools.ttLib import TTFont

DROPPED = {"liga", "dlig", "calt"}


def strip(font: TTFont) -> list[str]:
    if "GSUB" not in font:
        return []
    table = font["GSUB"].table
    records = table.FeatureList.FeatureRecord
    keep = [i for i, record in enumerate(records) if record.FeatureTag not in DROPPED]
    remap = {old: new for new, old in enumerate(keep)}
    table.FeatureList.FeatureRecord = [records[i] for i in keep]
    table.FeatureList.FeatureCount = len(keep)
    for script in table.ScriptList.ScriptRecord:
        systems = [script.Script.DefaultLangSys] + [r.LangSys for r in script.Script.LangSysRecord]
        for system in systems:
            if system is None:
                continue
            system.FeatureIndex = [remap[i] for i in system.FeatureIndex if i in remap]
            system.FeatureCount = len(system.FeatureIndex)
            if system.ReqFeatureIndex != 0xFFFF:
                system.ReqFeatureIndex = remap.get(system.ReqFeatureIndex, 0xFFFF)
    return sorted({r.FeatureTag for r in table.FeatureList.FeatureRecord})


def main(source: str, target: str) -> None:
    font = TTFont(source)
    features = strip(font)
    font.save(target)
    left = DROPPED.intersection(features)
    if left:
        sys.exit(f"still has {sorted(left)}")
    print(f"{target}: {len(TTFont(target).getBestCmap())} characters, GSUB features {features}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
