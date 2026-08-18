# Live-gallery data: where it lives, who can write it, how it is cached

The demos at [pieper.github.io/live](https://pieper.github.io/live) stream their imaging data
from public JS2 (Jetstream2) object storage, not from the gallery repo. This is the operational
map — it took a while to work out, so it is written down.

## Containers

Base: `https://js2.jetstream-cloud.org:8001/swift/v1/<container>/`

| container | objects | size | used by | writable with |
|---|---|---|---|---|
| `slicerlive` | 1380 | 371 MB | cardiac, endovascular, colorize, MRHead, CTACardio, CTAAbdomenPanoramix, TotalSegmentator-CT | `CIS230102_IU` |
| `livecodec-demo` | 465 | 4.7 GB | codec race | `CIS230102_IU` |
| `spine-review` | 1632 | 5.0 GB | SPINEPS vs IDC spine review | `MED250016_IU` |
| `nnlive-models` | 4 | 225 MB | nnLive interactive segmentation | `MED250016_IU` |

Credentials are the application credentials in `~/.config/openstack/clouds.yaml`. **The mapping
is not obvious and the two projects do not overlap**: `CIS230102_IU` gets 403 on spine-review and
nnlive-models, `MED250016_IU` gets 403 on slicerlive and livecodec-demo, and `BIO240357_IU` gets
403 on all four. A 403 from a POST looks exactly like a transient failure to a retry loop, so a
bulk job against the wrong container will grind through its retries instead of failing fast.

`livecodec-demo` has `.r:*` but not `.rlistings`, so anonymous listing 403s while individual
objects are public. Listing it needs a token.

## Cache-Control policy

Applied by [`tools/set_cache_control.py`](../tools/set_cache_control.py). Three tiers, because
"immutable" is not equally true of everything:

| tier | value | what | count |
|---|---|---|---|
| bulk data | `public, max-age=31536000, immutable` | zarr chunks, weights, scan volumes | 3053 |
| per-item metadata | `public, max-age=86400` | text/json nested 2+ deep (`mets/<case>/zarr/meta.json`) | 411 |
| entry pointers | `public, max-age=600, must-revalidate` | text/json at depth 0-1 (`cases.json`, `colorize/colorize.json`) | 17 |

The pointers say *which* data exists and get regenerated in place, so they must stay recoverable —
marking them immutable would pin a returning visitor to a stale index for a year. Per-item metadata
is cached hard for a day: it changes only when its own case is regenerated, and there are ~400 of
them, so making them revalidate would cost ~400 round trips per visit.

Measured effect: a repeat visit to the colorize demo serves all 481 objects from cache with **zero**
revalidation requests and 0 MB on the wire.

## The trap: Swift POST REPLACES metadata

Setting Cache-Control is an object `POST`, which does not touch the body (ETag is unchanged) but
**replaces the metadata**. Omit `Content-Type` and the object silently inherits the request's own
type — `application/x-www-form-urlencoded` for both curl and urllib defaults. That is how 294
objects in `slicerlive` lost their type on the first pass; they had to be repaired afterwards.

Always re-send `Content-Type`. Get it from the container listing (`?format=json`) — except that
**objects written through the S3 API have `content_type: null` in the *Swift* listing** (457 of
livecodec-demo's 465), so fall back to a `HEAD`, which does report it. `tools/set_cache_control.py`
does both and refuses to POST an object whose type it cannot determine.
