#!/usr/bin/env python3
"""
encodeKtx2.py — PNG -> KTX2 supercompressed, shared by every art tool.

WHY IT EXISTS. Uncompressed, the art library was measured at ~196 MiB against a 200 MiB budget, and
the facade arrays alone are 85 MiB of that. VRAM is the one budget in this project with no headroom
to borrow from, and 4 MiB of margin is not margin.

CODEC CHOICE IS NOT A PREFERENCE:
  UASTC  — anything with an ALPHA channel that carries DATA (the facade window mask), and any NORMAL
           map. ETC1S quantises to a small palette, which is fine for photographic colour and wrong
           for a mask (it bands the edges) and wrong for a normal (banded normals read as facets).
  ETC1S  — opaque colour, where its ~6:1 beats UASTC's ~4:1 and the artefacts hide in photographic
           detail.

Both stay GPU-compressed in memory after transcode, which is the entire point — a KTX2 that
decompresses to RGBA on upload saves download size and nothing else.
"""
import os, subprocess, sys


def encode(png_path, out_path=None, *, codec='etc1s', quality=128, normal_map=False, mipmaps=True):
    """Returns (out_path, src_bytes, out_bytes). Raises if basisu is missing or fails."""
    out_path = out_path or os.path.splitext(png_path)[0] + '.ktx2'
    cmd = ['basisu', '-ktx2', '-file', png_path, '-output_file', out_path]
    if mipmaps:
        cmd.append('-mipmap')
    if codec == 'uastc':
        cmd += ['-uastc', '-uastc_level', '2', '-uastc_rdo_l', '1.0']
    else:
        cmd += ['-q', str(quality)]
    if normal_map:
        # Tells the encoder to treat the data as a normal map: no sRGB transfer, and angular error
        # weighted rather than perceptual error, which is what stops normals banding into facets.
        cmd.append('-normal_map')
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out_path):
        raise SystemExit(f'basisu failed for {png_path}:\n{r.stdout[-800:]}\n{r.stderr[-800:]}')
    return out_path, os.path.getsize(png_path), os.path.getsize(out_path)


def encode_set(items, label=''):
    """items: [(png, codec, is_normal)]. Prints a per-file and total saving."""
    tot_src = tot_out = 0
    for png, codec, is_nrm in items:
        out, a, b = encode(png, codec=codec, normal_map=is_nrm)
        tot_src += a
        tot_out += b
        print(f'    {os.path.basename(out):38s} {a/1048576:6.2f} -> {b/1048576:5.2f} MB  '
              f'({codec}{", normal" if is_nrm else ""})')
    if tot_src:
        print(f'    {label} total {tot_src/1048576:.1f} -> {tot_out/1048576:.1f} MB '
              f'({tot_src/max(tot_out,1):.1f}:1)')
    return tot_src, tot_out


if __name__ == '__main__':
    print(encode(sys.argv[1], codec=sys.argv[2] if len(sys.argv) > 2 else 'etc1s'))


def encode_array(png_paths, out_path, *, codec='uastc', normal_map=False):
    """
    Encode an ORDERED list of PNGs into ONE KTX2 2D-ARRAY texture.

    Separate per-layer KTX2 files would compress just as well on disk and be useless: the renderer
    needs a single array texture so each layer wraps independently (that is the whole reason
    facadeArray.js is an array and not an atlas). Loading eight files into a DataArrayTexture instead
    would decompress every one to RGBA8 on upload, which throws the entire VRAM saving away — 85 MiB
    instead of 21. The file must arrive already layered and already compressed.

    Layer index is input order, so the caller's list IS the layer mapping.
    """
    cmd = ['basisu', '-ktx2', '-tex_type', '2darray', '-tex_array', '-mipmap']
    if codec == 'uastc':
        cmd += ['-uastc', '-uastc_level', '2']
    else:
        cmd += ['-q', '128']
    if normal_map:
        cmd.append('-normal_map')
    for p in png_paths:
        cmd += ['-file', p]
    cmd += ['-output_file', out_path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out_path):
        raise SystemExit(f'basisu array encode failed:\n{r.stdout[-800:]}\n{r.stderr[-800:]}')
    return out_path, os.path.getsize(out_path)
