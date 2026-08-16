// ---------------------------------------------------------------------------
// cs3d-tex — texture exports the Source2Viewer-CLI cannot do, over the
// ValveResourceFormat library.
//
//   cs3d-tex cube <vpk> <materials/skybox/foo.vtex_c> <outDir> [name] [size]
//       A cube texture (every CS2 skybox) → <outDir>/<name>.hdr, an
//       equirectangular Radiance RGBE image already in the scene's frame.
//
//   cs3d-tex hdr2d <vpk> <maps/x/lightmaps/irradiance.vtex_c> <outDir> [name] [size] [scale]
//       A 2D HDR texture (the baked irradiance lightmap, BC6H) → <outDir>/<name>.png,
//       16-bit RGBA PNG holding LINEAR light × scale (default 4096, so 16.0
//       units of radiance saturate), box-downsampled to at most `size` px.
//       A 16-bit PNG is the one HDR intermediate both this program and sharp
//       (the pack step) can read; the pack re-encodes it as RGBM for the web.
//
// The first form exists because the CLI throws a NullReferenceException on
// cube textures (18.0 and 19.2), and because Source cubes are z-up: our scene
// is y-up, which rotates each face's contents, not just its name. Resampling
// to equirect applies that rotation once, exactly. The second exists because
// the CLI tonemaps HDR textures to 8-bit on the way out, and a lightmap has
// to reach the browser linear.
//
// Everything stays linear HDR: the browser tonemaps once on the way to the
// screen; a pre-tonemapped sky (or lightmap) flattened twice comes out grey.
// ---------------------------------------------------------------------------

using SkiaSharp;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.TextureDecoders;

if (args.Length < 4)
{
    Console.Error.WriteLine("usage: cs3d-tex cube|hdr2d <vpk> <resourcePath> <outDir> [name] [size] [scale]");
    return 2;
}

var mode = args[0];
var vpkPath = args[1];
var resourcePath = args[2].Replace('\\', '/');
var outDir = args[3];
var name = args.Length > 4 ? args[4] : Path.GetFileNameWithoutExtension(resourcePath);
var size = args.Length > 5 ? int.Parse(args[5]) : (mode == "cube" ? 1024 : 4096);
var scale = args.Length > 6 ? float.Parse(args[6], System.Globalization.CultureInfo.InvariantCulture) : 4096f;

Directory.CreateDirectory(outDir);

using var package = new Package();
package.Read(vpkPath);

var entry = package.FindEntry(resourcePath);
if (entry == null)
{
    Console.Error.WriteLine($"not found in package: {resourcePath}");
    return 3;
}

package.ReadEntry(entry, out var bytes);
using var resource = new Resource();
resource.Read(new MemoryStream(bytes));

if (resource.DataBlock is not Texture texture)
{
    Console.Error.WriteLine($"not a texture: {resourcePath}");
    return 4;
}

return mode switch
{
    "cube" => ExportCube(texture, outDir, name, size),
    "hdr2d" => ExportHdr2D(texture, outDir, name, size, scale),
    "mask2d" => ExportMask2D(texture, outDir, name, size),
    "vol3d" => ExportVolume(texture, outDir, name),
    _ => Usage()
};

static int Usage()
{
    Console.Error.WriteLine("mode must be cube, hdr2d, mask2d or vol3d");
    return 2;
}

// ---------------------------------------------------------------------------
// 3D HDR volume -> flat RGBE
//
// For env_light_probe_volume_atlas: a BC6H volume holding the map's baked
// light probes. Nuke's is 200 x 188 x 648, and the 648 is six stacked planes
// of 108 -- an ambient cube, irradiance for +X,-X,+Y,-Y,+Z,-Z. Every probe
// volume entity says where its own block sits inside it.
//
// RGBE rather than float: this is a pack-time intermediate that never reaches
// the browser, and 4 bytes a texel keeps a 24M-texel volume under 100 MB
// instead of 292. The exponent form carries the HDR range exactly enough for
// irradiance, which spans a couple of stops, not twenty.
// ---------------------------------------------------------------------------

static int ExportVolume(Texture texture, string outDir, string name)
{
    var w = texture.Width;
    var h = texture.Height;
    var d = texture.Depth;
    if (d <= 1)
    {
        Console.Error.WriteLine($"vol3d: {name} is not a volume texture (depth {d})");
        return 7;
    }
    var file = Path.Combine(outDir, $"{name}.rgbe");
    using var fs = File.Create(file);
    using var bw = new BinaryWriter(fs);
    // Explicit int32: VTEX dimensions are ushort, and BinaryWriter would
    // otherwise emit a 6-byte header the reader is not expecting.
    bw.Write((int)w);
    bw.Write((int)h);
    bw.Write((int)d);
    var slice = new byte[w * h * 4];
    for (uint z = 0; z < d; z++)
    {
        using var bmp = texture.GenerateBitmap(z, 0, 0, TextureCodec.None);
        var isHdr = bmp.ColorType == SKColorType.RgbaF32;
        var span = bmp.GetPixelSpan();
        for (var i = 0; i < w * h; i++)
        {
            float r, g, b;
            if (isHdr)
            {
                var o = i * 16;
                r = BitConverter.ToSingle(span.Slice(o, 4));
                g = BitConverter.ToSingle(span.Slice(o + 4, 4));
                b = BitConverter.ToSingle(span.Slice(o + 8, 4));
            }
            else
            {
                var o = i * 4;
                b = span[o] / 255f;
                g = span[o + 1] / 255f;
                r = span[o + 2] / 255f;
            }
            var max = MathF.Max(r, MathF.Max(g, b));
            var oo = i * 4;
            if (max < 1e-32f)
            {
                slice[oo] = slice[oo + 1] = slice[oo + 2] = slice[oo + 3] = 0;
                continue;
            }
            var e = Math.Clamp((int)MathF.Ceiling(MathF.Log2(max)), -128, 127);
            var s = MathF.Pow(2f, -e) * 256f;
            slice[oo] = (byte)Math.Clamp(r * s, 0, 255);
            slice[oo + 1] = (byte)Math.Clamp(g * s, 0, 255);
            slice[oo + 2] = (byte)Math.Clamp(b * s, 0, 255);
            slice[oo + 3] = (byte)(e + 128);
        }
        bw.Write(slice);
    }
    Console.WriteLine($"{name} {w}x{h}x{d} volume -> rgbe ({(long)w * h * d * 4 / 1_000_000} MB)");
    return 0;
}

// ---------------------------------------------------------------------------
// 2D LDR mask → 8-bit RGBA PNG, channels kept independent
//
// For direct_light_shadows: a BC7 texture array whose R/G/B are one baked
// shadow mask per light (world.kv3 m_bakedShadows maps light hash -> channel).
// The values are SHADOW, not visibility: 1 is fully occluded. They are written
// through unchanged; cs3d-pack.mjs inverts to visibility when it picks the
// sun's channel, and its comment records how that direction was measured.
// Unlike hdr2d this does NOT sRGB-decode: m_bBakedShadowsGamma20 is false, so
// the stored values are already linear, and "decoding" them would darken every
// penumbra.
// ---------------------------------------------------------------------------

static int ExportMask2D(Texture texture, string outDir, string name, int maxSize)
{
    if ((texture.Flags & VTexFlags.CUBE_TEXTURE) != 0)
    {
        Console.Error.WriteLine("mask2d: got a cube texture; use the cube mode");
        return 5;
    }
    using var bmp = texture.GenerateBitmap(0, 0, 0, TextureCodec.None);
    if (bmp.ColorType == SKColorType.RgbaF32)
    {
        Console.Error.WriteLine("mask2d: got a float texture; use hdr2d");
        return 6;
    }
    var w = bmp.Width;
    var h = bmp.Height;
    var factor = 1;
    while (Math.Max(w, h) / factor > maxSize) factor *= 2;
    var ow = w / factor;
    var oh = h / factor;
    var span = bmp.GetPixelSpan();
    var pixels = new byte[ow * oh * 4];
    var acc = new int[4];
    var means = new double[4];
    for (var y = 0; y < oh; y++)
    {
        for (var x = 0; x < ow; x++)
        {
            acc[0] = acc[1] = acc[2] = acc[3] = 0;
            for (var sy = 0; sy < factor; sy++)
            {
                for (var sx = 0; sx < factor; sx++)
                {
                    // Bgra8888 in, straight average, no colour transform.
                    var o = ((y * factor + sy) * w + (x * factor + sx)) * 4;
                    acc[0] += span[o + 2];
                    acc[1] += span[o + 1];
                    acc[2] += span[o];
                    acc[3] += span[o + 3];
                }
            }
            var n = factor * factor;
            var oo = (y * ow + x) * 4;
            for (var c = 0; c < 4; c++)
            {
                var v = (byte)(acc[c] / n);
                pixels[oo + c] = v;
                means[c] += v;
            }
        }
    }
    WritePng8(Path.Combine(outDir, $"{name}.png"), pixels, ow, oh);
    var total = (double)ow * oh * 255;
    Console.WriteLine(
        $"{name} {w}x{h} mask -> {ow}x{oh} png8 means " +
        $"{means[0] / total:F3},{means[1] / total:F3},{means[2] / total:F3},{means[3] / total:F3}");
    return 0;
}

// ---------------------------------------------------------------------------
// 2D HDR → 16-bit linear PNG
// ---------------------------------------------------------------------------

static int ExportHdr2D(Texture texture, string outDir, string name, int maxSize, float scale)
{
    if ((texture.Flags & VTexFlags.CUBE_TEXTURE) != 0)
    {
        Console.Error.WriteLine("hdr2d: got a cube texture; use the cube mode");
        return 5;
    }
    // TextureCodec.None keeps the values linear; Auto would tonemap here.
    using var bmp = texture.GenerateBitmap(0, 0, 0, TextureCodec.None);
    var isHdr = bmp.ColorType == SKColorType.RgbaF32;
    var w = bmp.Width;
    var h = bmp.Height;
    // Box-downsample by an integer factor so 8192 → 4096 averages 2×2 texels
    // exactly (a lightmap is low-frequency light; averaging is the right filter).
    var factor = 1;
    while (Math.Max(w, h) / factor > maxSize) factor *= 2;
    var ow = w / factor;
    var oh = h / factor;
    var span = bmp.GetPixelSpan();
    var outPx = new ushort[ow * oh * 4];
    var acc = new double[4];
    for (var y = 0; y < oh; y++)
    {
        for (var x = 0; x < ow; x++)
        {
            acc[0] = acc[1] = acc[2] = acc[3] = 0;
            for (var sy = 0; sy < factor; sy++)
            {
                for (var sx = 0; sx < factor; sx++)
                {
                    var px = (y * factor + sy) * w + (x * factor + sx);
                    if (isHdr)
                    {
                        var o = px * 16;
                        acc[0] += BitConverter.ToSingle(span.Slice(o, 4));
                        acc[1] += BitConverter.ToSingle(span.Slice(o + 4, 4));
                        acc[2] += BitConverter.ToSingle(span.Slice(o + 8, 4));
                        acc[3] += BitConverter.ToSingle(span.Slice(o + 12, 4));
                    }
                    else
                    {
                        // Bgra8888, sRGB-encoded.
                        var o = px * 4;
                        acc[2] += SrgbToLinear(span[o] / 255f);
                        acc[1] += SrgbToLinear(span[o + 1] / 255f);
                        acc[0] += SrgbToLinear(span[o + 2] / 255f);
                        acc[3] += span[o + 3] / 255f;
                    }
                }
            }
            var n = factor * factor;
            var oo = (y * ow + x) * 4;
            outPx[oo] = (ushort)Math.Clamp(acc[0] / n * scale, 0, 65535);
            outPx[oo + 1] = (ushort)Math.Clamp(acc[1] / n * scale, 0, 65535);
            outPx[oo + 2] = (ushort)Math.Clamp(acc[2] / n * scale, 0, 65535);
            outPx[oo + 3] = 65535;
        }
    }
    WritePng16(Path.Combine(outDir, $"{name}.png"), outPx, ow, oh);
    Console.WriteLine($"{name} {w}x{h} {(isHdr ? "hdr" : "ldr")} -> {ow}x{oh} png16 x{scale}");
    return 0;
}

/// <summary>
/// Minimal 8-bit RGBA PNG writer. Hand-rolled like the 16-bit one so the
/// bytes reach disk untouched: SkiaSharp's encoder is free to premultiply or
/// drop a fully transparent pixel's colour, and here every channel is an
/// independent mask, not a colour with an alpha.
/// </summary>
static void WritePng8(string file, byte[] rgba, int w, int h)
{
    using var fs = File.Create(file);
    fs.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
    var ihdr = new byte[13];
    WriteBE(ihdr, 0, w);
    WriteBE(ihdr, 4, h);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    WriteChunk(fs, "IHDR", ihdr);
    var stride = w * 4;
    var raw = new byte[(stride + 1) * h];
    for (var y = 0; y < h; y++)
    {
        var ro = y * (stride + 1);
        raw[ro] = 0; // filter: none
        Array.Copy(rgba, y * stride, raw, ro + 1, stride);
    }
    using var ms = new MemoryStream();
    using (var z = new System.IO.Compression.ZLibStream(ms, System.IO.Compression.CompressionLevel.Optimal, leaveOpen: true))
    {
        z.Write(raw, 0, raw.Length);
    }
    WriteChunk(fs, "IDAT", ms.ToArray());
    WriteChunk(fs, "IEND", Array.Empty<byte>());
}

/// <summary>Minimal 16-bit RGBA PNG writer (SkiaSharp cannot encode 16-bit).</summary>
static void WritePng16(string file, ushort[] rgba, int w, int h)
{
    using var fs = File.Create(file);
    fs.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
    var ihdr = new byte[13];
    WriteBE(ihdr, 0, w);
    WriteBE(ihdr, 4, h);
    ihdr[8] = 16; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    WriteChunk(fs, "IHDR", ihdr);
    // Raw scanlines: filter byte 0 + big-endian 16-bit samples.
    var stride = w * 8;
    var raw = new byte[(stride + 1) * h];
    for (var y = 0; y < h; y++)
    {
        var ro = y * (stride + 1);
        raw[ro] = 0;
        for (var x = 0; x < w * 4; x++)
        {
            var v = rgba[y * w * 4 + x];
            raw[ro + 1 + x * 2] = (byte)(v >> 8);
            raw[ro + 2 + x * 2] = (byte)(v & 0xff);
        }
    }
    using var ms = new MemoryStream();
    using (var z = new System.IO.Compression.ZLibStream(ms, System.IO.Compression.CompressionLevel.Optimal, leaveOpen: true))
    {
        z.Write(raw, 0, raw.Length);
    }
    WriteChunk(fs, "IDAT", ms.ToArray());
    WriteChunk(fs, "IEND", Array.Empty<byte>());
}

static void WriteBE(byte[] b, int o, int v)
{
    b[o] = (byte)(v >> 24);
    b[o + 1] = (byte)(v >> 16);
    b[o + 2] = (byte)(v >> 8);
    b[o + 3] = (byte)v;
}

static void WriteChunk(Stream s, string type, byte[] data)
{
    var len = new byte[4];
    WriteBE(len, 0, data.Length);
    s.Write(len);
    var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
    s.Write(typeBytes);
    s.Write(data);
    var crc = new System.IO.Hashing.Crc32();
    crc.Append(typeBytes);
    crc.Append(data);
    var crcBytes = crc.GetCurrentHash(); // little-endian
    s.Write(new[] { crcBytes[3], crcBytes[2], crcBytes[1], crcBytes[0] });
}

// ---------------------------------------------------------------------------
// Cube → equirect Radiance HDR
// ---------------------------------------------------------------------------

static int ExportCube(Texture texture, string outDir, string name, int size)
{
    if ((texture.Flags & VTexFlags.CUBE_TEXTURE) == 0)
    {
        Console.Error.WriteLine("not a cube texture; use hdr2d (or Source2Viewer-CLI) for 2D textures");
        return 5;
    }

    var faces = new SKBitmap[6];
    for (var i = 0; i < 6; i++)
    {
        // TextureCodec.None keeps the values linear; Auto would tonemap here.
        faces[i] = texture.GenerateBitmap(0, (Texture.CubemapFace)i, 0, TextureCodec.None);
    }
    var isHdr = faces[0].ColorType == SKColorType.RgbaF32;
    var faceSize = faces[0].Width;

    var outW = Math.Max(512, size * 2);
    var outH = outW / 2;
    var pixels = new float[outW * outH * 3];

    for (var y = 0; y < outH; y++)
    {
        // Row 0 is the top of the image = straight up. three's equirectUv is
        // u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5, v = 1 at the top.
        var v = 1.0 - (y + 0.5) / outH;
        var phi = (v - 0.5) * Math.PI; // -pi/2 down .. +pi/2 up
        var cosPhi = Math.Cos(phi);
        var sy = (float)Math.Sin(phi);
        for (var x = 0; x < outW; x++)
        {
            var u = (x + 0.5) / outW;
            var theta = (u - 0.5) * 2.0 * Math.PI;
            var sx = (float)(cosPhi * Math.Cos(theta));
            var sz = (float)(cosPhi * Math.Sin(theta));
            // scene (x, y, z) -> source (x, -z, y); see shared/sim3d/units.js.
            SampleCube(faces, faceSize, isHdr, sx, -sz, sy, out var r, out var g, out var b);
            var o = (y * outW + x) * 3;
            pixels[o] = r;
            pixels[o + 1] = g;
            pixels[o + 2] = b;
        }
    }

    WriteRadianceHdr(Path.Combine(outDir, $"{name}.hdr"), pixels, outW, outH);
    foreach (var f in faces) f.Dispose();
    Console.WriteLine($"{name} {texture.Width}x{texture.Height} cube -> {outW}x{outH} equirect {(isHdr ? "hdr" : "ldr")}");
    return 0;
}

/// <summary>
/// Sample a Source cubemap along a direction given in SOURCE space (z up),
/// using the standard major-axis face selection with bilinear filtering.
/// </summary>
static void SampleCube(SKBitmap[] faces, int size, bool isHdr, float dx, float dy, float dz,
    out float r, out float g, out float b)
{
    var ax = MathF.Abs(dx);
    var ay = MathF.Abs(dy);
    var az = MathF.Abs(dz);

    // Standard cube face selection. The ±X rows take sc from Z and tc from Y
    // (not the other way round) — getting that backwards leaves the other four
    // faces correct and those two rotated, which reads as a sky with two bad
    // faces and a hard wedge at the seam.
    int faceIndex;
    float sc, tc, ma;
    if (ax >= ay && ax >= az)
    {
        ma = ax;
        if (dx > 0) { faceIndex = 0; sc = -dz; tc = -dy; }
        else { faceIndex = 1; sc = dz; tc = -dy; }
    }
    else if (ay >= az)
    {
        ma = ay;
        if (dy > 0) { faceIndex = 2; sc = dx; tc = dz; }
        else { faceIndex = 3; sc = dx; tc = -dz; }
    }
    else
    {
        ma = az;
        if (dz > 0) { faceIndex = 4; sc = dx; tc = -dy; }
        else { faceIndex = 5; sc = -dx; tc = -dy; }
    }

    var fu = (sc / ma + 1f) * 0.5f * (size - 1);
    var fv = (tc / ma + 1f) * 0.5f * (size - 1);
    Bilinear(faces[faceIndex], size, isHdr, fu, fv, out r, out g, out b);
}

static void Bilinear(SKBitmap bmp, int size, bool isHdr, float fu, float fv,
    out float r, out float g, out float b)
{
    var x0 = (int)MathF.Floor(fu);
    var y0 = (int)MathF.Floor(fv);
    var tx = fu - x0;
    var ty = fv - y0;
    var x1 = Math.Clamp(x0 + 1, 0, size - 1);
    var y1 = Math.Clamp(y0 + 1, 0, size - 1);
    x0 = Math.Clamp(x0, 0, size - 1);
    y0 = Math.Clamp(y0, 0, size - 1);

    Texel(bmp, size, isHdr, x0, y0, out var r00, out var g00, out var b00);
    Texel(bmp, size, isHdr, x1, y0, out var r10, out var g10, out var b10);
    Texel(bmp, size, isHdr, x0, y1, out var r01, out var g01, out var b01);
    Texel(bmp, size, isHdr, x1, y1, out var r11, out var g11, out var b11);

    r = Lerp(Lerp(r00, r10, tx), Lerp(r01, r11, tx), ty);
    g = Lerp(Lerp(g00, g10, tx), Lerp(g01, g11, tx), ty);
    b = Lerp(Lerp(b00, b10, tx), Lerp(b01, b11, tx), ty);
}

static float Lerp(float a, float b, float t) => a + (b - a) * t;

static void Texel(SKBitmap bmp, int size, bool isHdr, int x, int y,
    out float r, out float g, out float b)
{
    var span = bmp.GetPixelSpan();
    if (isHdr)
    {
        var o = (y * size + x) * 16;
        r = BitConverter.ToSingle(span.Slice(o, 4));
        g = BitConverter.ToSingle(span.Slice(o + 4, 4));
        b = BitConverter.ToSingle(span.Slice(o + 8, 4));
    }
    else
    {
        var o = (y * size + x) * 4;
        // SKColorType.Bgra8888, and LDR bytes are sRGB-encoded.
        b = SrgbToLinear(span[o] / 255f);
        g = SrgbToLinear(span[o + 1] / 255f);
        r = SrgbToLinear(span[o + 2] / 255f);
    }
}

static float SrgbToLinear(float c) =>
    c <= 0.04045f ? c / 12.92f : MathF.Pow((c + 0.055f) / 1.055f, 2.4f);

/// <summary>
/// Flat float RGB -> Radiance RGBE .hdr with per-scanline RLE, which is what
/// three's RGBELoader reads.
/// </summary>
static void WriteRadianceHdr(string file, float[] rgb, int w, int h)
{
    using var fs = File.Create(file);
    using var bw = new BinaryWriter(fs);
    bw.Write("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n"u8);
    bw.Write(System.Text.Encoding.ASCII.GetBytes($"-Y {h} +X {w}\n"));

    var comp = new byte[4][];
    for (var c = 0; c < 4; c++) comp[c] = new byte[w];

    for (var y = 0; y < h; y++)
    {
        for (var x = 0; x < w; x++)
        {
            var o = (y * w + x) * 3;
            float r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
            var max = MathF.Max(r, MathF.Max(g, b));
            if (max < 1e-32f)
            {
                comp[0][x] = comp[1][x] = comp[2][x] = comp[3][x] = 0;
                continue;
            }
            var e = Math.Clamp((int)MathF.Ceiling(MathF.Log2(max)), -128, 127);
            var scale = MathF.Pow(2f, -e) * 256f;
            comp[0][x] = (byte)Math.Clamp(r * scale, 0, 255);
            comp[1][x] = (byte)Math.Clamp(g * scale, 0, 255);
            comp[2][x] = (byte)Math.Clamp(b * scale, 0, 255);
            comp[3][x] = (byte)(e + 128);
        }

        bw.Write((byte)2);
        bw.Write((byte)2);
        bw.Write((byte)(w >> 8));
        bw.Write((byte)(w & 0xff));
        for (var c = 0; c < 4; c++) WriteRleComponent(bw, comp[c], w);
    }
}

/// <summary>Radiance per-component RLE: runs as (128+n, value), literals as (n, bytes).</summary>
static void WriteRleComponent(BinaryWriter bw, byte[] data, int w)
{
    var x = 0;
    while (x < w)
    {
        var run = 1;
        while (x + run < w && data[x + run] == data[x] && run < 127) run++;
        if (run >= 4)
        {
            bw.Write((byte)(128 + run));
            bw.Write(data[x]);
            x += run;
            continue;
        }
        var start = x;
        var len = 0;
        while (x < w && len < 128)
        {
            var ahead = 1;
            while (x + ahead < w && data[x + ahead] == data[x] && ahead < 4) ahead++;
            if (ahead >= 4) break;
            x++;
            len++;
        }
        bw.Write((byte)len);
        bw.Write(data, start, len);
    }
}
