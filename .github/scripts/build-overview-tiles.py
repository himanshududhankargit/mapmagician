import argparse, collections, datetime, hashlib, io, json, os, re, sys, tempfile, urllib.request
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.exceptions import ClientError
from PIL import Image

# Zoomed-out OVERVIEW tiles: one merged, blurry pyramid of every web DP plan for the zooms BELOW
# the plans' own minimum (z8-10 by default), so a user zoomed out to 10 still sees where the maps
# are instead of bare satellite. Drawn by OverviewMapType in maps*-app.js.
#
# Why ONE merged pyramid and not "draw each plan's z11 tiles at 10" in the browser: web plans are
# ~500 small folders, each fetched separately. Measured 2026-09-29, a desktop view over Pune would
# need 458 requests at z10, 773 at z9 and 891 at z8 that way. The merged pyramid needs ~10-30.
#
# AUTOMATIC: .github/workflows/build-overview.yml runs this on every d1.bin publish and weekly
# (for tiles re-uploaded in place, which change no RTDB record). A run whose inputs are unchanged
# — same plans, same order, same tile ETags — exits before downloading anything.
#
# By hand (from the mapmagician-main root; needs AWS read on MapMagicianTM/dpplans/* and write on
# MapMagicianTM/dpplans/_overview/*):
#   python .github/scripts/build-overview-tiles.py            # dry run: build + preview PNG
#   python .github/scripts/build-overview-tiles.py --upload   # upload + write the manifest
# then commit + push data/coverage/overview.json.
#
# 🛑 Every build gets a NEW <id> path, never an overwrite. CloudFront caches a 404 for ~100 years
# (ErrorCachingMinTTL), and browsers keep tiles in IndexedDB by URL, so reusing a path would pin
# stale or missing tiles forever. The manifest lists exactly which tiles exist, so the map never
# requests one that is not there. --prune deletes old builds only once they are PRUNE_AFTER_DAYS
# old (open tabs keep the manifest they loaded).

BUCKET = 'www.mapdata.com'
OUT_PREFIX = 'MapMagicianTM/dpplans/_overview'
LIVE_D1 = 'https://www.mapmagician.in/data/database/d1.bin'
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
MANIFEST = os.path.join(REPO, 'data', 'coverage', 'overview.json')
DEFAULT_MIN_ZOOM = 11      # a blank MinZoom means 11 on the web (maps-app.js processLayerData)
CACHE_MAX_AGE_S = 2 * 3600
PRUNE_AFTER_DAYS = 3
KEEP_BUILDS = 3            # never prune the newest few, whatever their age
FORMAT_VERSION = 1         # bump when the tile RENDERING changes, so unchanged inputs still rebuild
LINK_RE = re.compile(r'^/?(?:([^/]+)/)?dpplans/(.+?)/?$')

s3 = boto3.client('s3', region_name='ap-south-1')


def load_records(src):
    if re.match(r'^https?://', src):
        # The site 403s urllib's default User-Agent.
        req = urllib.request.Request(src + '?p=%d' % datetime.datetime.now().timestamp(),
                                     headers={'User-Agent': 'Mozilla/5.0 (build-overview-tiles)'})
        data = json.loads(urllib.request.urlopen(req).read())
    else:
        with open(src, encoding='utf-8') as f:
            data = json.load(f)
    rows = data.values() if isinstance(data, dict) else data
    out = []
    for order, r in enumerate(rows):
        if not isinstance(r, dict):
            continue
        link = re.sub(r'[\r\n\t]', '', r.get('link') or '').strip()
        if not LINK_RE.match(link):
            continue
        try:
            eff_min = int(str(r.get('MinZoom') or r.get('minZoom') or '').strip() or DEFAULT_MIN_ZOOM)
        except ValueError:
            eff_min = DEFAULT_MIN_ZOOM
        try:
            z_index = float(r.get('ZIndex') or r.get('zIndex') or 0)
        except ValueError:
            z_index = 0.0
        out.append({'s3': link.strip('/'), 'min': eff_min, 'z': z_index, 'order': order})
    return out


def _denied(err, prefix):
    # CI may only read MapMagicianTM/dpplans/*. A record pointing anywhere else (every web link was
    # under it on 2026-09-29) is left out of the overview rather than failing the whole build.
    if err.response['Error']['Code'] == 'AccessDenied':
        print('WARNING: no S3 access to %s — left out of the overview' % prefix)
        return True
    return False


def list_zoom_dirs(prefix):
    try:
        r = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix + '/', Delimiter='/')
    except ClientError as err:
        if _denied(err, prefix):
            return set()
        raise
    return set(int(p['Prefix'].rstrip('/').rsplit('/', 1)[1]) for p in r.get('CommonPrefixes', [])
               if p['Prefix'].rstrip('/').rsplit('/', 1)[1].isdigit())


def list_tiles(prefix, z):
    """-> {(x, y): etag}. Read from S3 itself rather than the coverage index: the index can lag a
    re-upload that added tiles, and an unattended run has nobody to rebuild it first."""
    out = {}
    try:
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix='%s/%d/' % (prefix, z)):
            for o in page.get('Contents', []):
                m = re.search(r'/(\d+)/(\d+)\.png$', o['Key'])
                if m:
                    out[(int(m.group(1)), int(m.group(2)))] = o['ETag'].strip('"')
    except ClientError as err:
        if _denied(err, prefix):
            return {}
        raise
    return out


def fetch(args):
    prefix, x, y, etag, cache_dir = args
    path = os.path.join(cache_dir, prefix.replace('/', '__'), '%d_%d_%d_%s.png' % (SRC_ZOOM, x, y, etag[:12]))
    # Keyed by ETag, so a tile re-uploaded in place can never be served from an old copy.
    if os.path.exists(path) and datetime.datetime.now().timestamp() - os.path.getmtime(path) < CACHE_MAX_AGE_S:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        body = s3.get_object(Bucket=BUCKET, Key='%s/%d/%d/%d.png' % (prefix, SRC_ZOOM, x, y))['Body'].read()
    except ClientError as err:
        if err.response['Error']['Code'] in ('NoSuchKey', '404'):
            return None                                    # deleted between the listing and now
        raise
    with open(path, 'wb') as f:
        f.write(body)
    return path


def encode(img):
    """Palette PNG with alpha — overview tiles are blurry by design, 256 colours is plenty and
    cuts the bytes ~3x against RGBA."""
    buf = io.BytesIO()
    img.quantize(colors=256, method=Image.Quantize.FASTOCTREE).save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def prune(current_id):
    """Delete builds older than PRUNE_AFTER_DAYS, always keeping the current one and the newest
    KEEP_BUILDS. Build ids start with a UTC yyyymmddHHMM stamp, so they sort by age."""
    r = s3.list_objects_v2(Bucket=BUCKET, Prefix=OUT_PREFIX + '/', Delimiter='/')
    ids = sorted((p['Prefix'][len(OUT_PREFIX) + 1:].rstrip('/') for p in r.get('CommonPrefixes', [])), reverse=True)
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=PRUNE_AFTER_DAYS)).strftime('%Y%m%d%H%M')
    doomed = [i for i in ids[KEEP_BUILDS:] if i != current_id and re.match(r'^\d{12}', i) and i[:12] < cutoff]
    for bid in doomed:
        keys = []
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix='%s/%s/' % (OUT_PREFIX, bid)):
            keys += [{'Key': o['Key']} for o in page.get('Contents', [])]
        for i in range(0, len(keys), 1000):
            s3.delete_objects(Bucket=BUCKET, Delete={'Objects': keys[i:i + 1000], 'Quiet': True})
        print('pruned old build %s (%d tiles)' % (bid, len(keys)))
    if not doomed:
        print('prune: nothing old enough to delete (%d builds kept)' % len(ids))


def set_output(name, value):
    gh = os.environ.get('GITHUB_OUTPUT')
    if gh:
        with open(gh, 'a') as f:
            f.write('%s=%s\n' % (name, value))


def main():
    global SRC_ZOOM
    ap = argparse.ArgumentParser()
    ap.add_argument('--zmin', type=int, default=8)
    ap.add_argument('--zmax', type=int, default=10)
    ap.add_argument('--src', type=int, default=11, help='zoom the overview is built from')
    ap.add_argument('--d1', default=LIVE_D1, help='d1.bin path or URL (CI passes the checked-out file)')
    ap.add_argument('--upload', action='store_true')
    ap.add_argument('--prune', action='store_true', help='after uploading, delete old builds')
    ap.add_argument('--force', action='store_true', help='rebuild even when the inputs are unchanged')
    ap.add_argument('--cache', default=os.path.join(tempfile.gettempdir(), 'mm_overview_cache'))
    ap.add_argument('--out', default=os.path.join(tempfile.gettempdir(), 'mm_overview_build'))
    a = ap.parse_args()
    SRC_ZOOM = a.src
    assert a.zmax < SRC_ZOOM, 'overview zooms must sit below the source zoom'
    set_output('changed', 'false')

    # A record only appears in the plan's normal range from its own MinZoom. Records that start
    # deeper than the source zoom (MinZoom 15 on a couple of sheets) stay out, or the overview
    # would show a plan at z10 that then vanishes between 11 and 14.
    recs = [r for r in load_records(a.d1) if r['min'] <= SRC_ZOOM]
    print('records drawn from:', len(recs))
    uniq = {}
    for r in recs:
        uniq.setdefault(r['s3'], r)
    with ThreadPoolExecutor(16) as ex:
        tiles = dict(zip(uniq, ex.map(lambda p: list_tiles(p, SRC_ZOOM), uniq)))
        # Zoom levels are only needed to spot sheets the map ALREADY draws below the source zoom.
        low = [p for p, r in uniq.items() if any(x['min'] <= a.zmax for x in recs if x['s3'] == p)]
        levels = dict(zip(low, ex.map(list_zoom_dirs, low)))

    # Per overview zoom: leave out records the map draws natively there (their MinZoom allows it
    # AND the folder really has tiles at that zoom), so they are not painted twice.
    contrib = {z: [] for z in range(a.zmin, a.zmax + 1)}
    for r in sorted(recs, key=lambda r: (r['z'], r['order'])):
        for z in contrib:
            if not (r['min'] <= z and z in levels.get(r['s3'], ())):
                contrib[z].append(r)

    # Fingerprint of everything the output depends on. Unchanged => stop before downloading.
    h = hashlib.sha256(json.dumps([FORMAT_VERSION, a.zmin, a.zmax, SRC_ZOOM,
                                   {z: [[r['s3'], sorted([x, y, e] for (x, y), e in tiles[r['s3']].items())]
                                        for r in rs] for z, rs in contrib.items()}],
                                  sort_keys=True).encode()).hexdigest()[:12]
    try:
        with open(MANIFEST, encoding='utf-8') as f:
            prev = json.load(f)
    except (OSError, ValueError):
        prev = {}
    if prev.get('inputHash') == h and not a.force:
        print('inputs unchanged since build %s — nothing to do' % prev.get('id'))
        return
    for z in contrib:
        print('z%d: %d records' % (z, len(contrib[z])))

    jobs = {(r['s3'], x, y, e) for z in contrib for r in contrib[z] for (x, y), e in tiles[r['s3']].items()}
    print('source tiles to fetch:', len(jobs))
    with ThreadPoolExecutor(24) as ex:
        paths = {(p, x, y): v for (p, x, y, e), v in zip(jobs, ex.map(fetch, [(p, x, y, e, a.cache) for (p, x, y, e) in jobs]))}

    now = datetime.datetime.now(datetime.timezone.utc)
    build_id = '%s-%s' % (now.strftime('%Y%m%d%H%M'), h[:8])
    out_root = os.path.join(a.out, build_id)
    manifest = {'v': 1, 'id': build_id, 'inputHash': h, 'generatedAt': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'prefix': '/%s/%s' % (OUT_PREFIX, build_id), 'zmin': a.zmin, 'zmax': a.zmax, 'src': SRC_ZOOM, 'tiles': {}}
    total_bytes = 0
    for z, rs in contrib.items():
        s = SRC_ZOOM - z
        span = 256 << s
        groups = collections.defaultdict(list)           # parent tile -> [(record rank, x, y, path)]
        for ri, r in enumerate(rs):
            for (x, y) in tiles[r['s3']]:
                p = paths.get((r['s3'], x, y))
                if p:
                    groups[(x >> s, y >> s)].append((ri, x, y, p))
        written = []
        for (tx, ty), items in sorted(groups.items()):
            canvas = Image.new('RGBA', (span, span), (0, 0, 0, 0))
            for _, x, y, p in sorted(items):            # zIndex order, same as the live map
                try:
                    child = Image.open(p).convert('RGBA')
                except Exception:
                    continue
                if child.size != (256, 256):
                    child = child.resize((256, 256), Image.LANCZOS)
                canvas.alpha_composite(child, ((x - (tx << s)) * 256, (y - (ty << s)) * 256))
            tile = canvas.resize((256, 256), Image.LANCZOS)   # Pillow premultiplies RGBA here
            if tile.getchannel('A').getextrema()[1] < 8:
                continue                                        # nothing visible left after shrinking
            data = encode(tile)
            path = os.path.join(out_root, str(z), str(tx), '%d.png' % ty)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as f:
                f.write(data)
            total_bytes += len(data)
            written.append([tx, ty])
        manifest['tiles'][str(z)] = written
        print('z%d: %d overview tiles' % (z, len(written)))
    n = sum(len(v) for v in manifest['tiles'].values())
    print('built %d tiles, %.1f KB total -> %s' % (n, total_bytes / 1024, out_root))
    if n == 0:
        sys.exit('refusing to publish an EMPTY overview — d1.bin unreadable or S3 listing failed')
    prev_n = sum(len(v) for v in (prev.get('tiles') or {}).values())
    if prev_n and n < prev_n * 0.5 and not a.force:
        sys.exit('refusing to publish: %d tiles vs %d last time — looks like a broken input, not a '
                 'real change. Re-run with --force if the plans really were removed.' % (n, prev_n))

    # Preview of the lowest zoom on grey, for a quick eyeball.
    t = manifest['tiles'][str(a.zmin)]
    if t:
        x0, x1 = min(v[0] for v in t), max(v[0] for v in t)
        y0, y1 = min(v[1] for v in t), max(v[1] for v in t)
        prev_img = Image.new('RGBA', ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256), (90, 90, 90, 255))
        for tx, ty in t:
            im = Image.open(os.path.join(out_root, str(a.zmin), str(tx), '%d.png' % ty)).convert('RGBA')
            prev_img.alpha_composite(im, ((tx - x0) * 256, (ty - y0) * 256))
        pv = os.path.join(a.out, 'preview_z%d_%s.png' % (a.zmin, build_id))
        prev_img.save(pv)
        print('preview:', pv)

    if not a.upload:
        print('dry run — nothing uploaded, manifest not written. Re-run with --upload.')
        return

    def put(item):
        z, tx, ty = item
        with open(os.path.join(out_root, str(z), str(tx), '%d.png' % ty), 'rb') as f:
            s3.put_object(Bucket=BUCKET, Key='%s/%s/%d/%d/%d.png' % (OUT_PREFIX, build_id, z, tx, ty), Body=f.read(),
                          ContentType='image/png', CacheControl='public, max-age=31536000, immutable')
    items = [(int(z), tx, ty) for z, v in manifest['tiles'].items() for tx, ty in v]
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(put, items))
    print('uploaded %d tiles to s3://%s/%s/%s/' % (len(items), BUCKET, OUT_PREFIX, build_id))
    # Manifest last: it must never name a tile that is not already uploaded.
    with open(MANIFEST, 'w', newline='\n') as f:
        json.dump(manifest, f, separators=(',', ':'))
    print('manifest ->', MANIFEST)
    set_output('changed', 'true')
    set_output('build_id', build_id)
    set_output('tiles', str(n))
    if a.prune:
        prune(build_id)


if __name__ == '__main__':
    SRC_ZOOM = 11
    main()
