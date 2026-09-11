# `aoba-city.json` — city data schema

This is the contract between the city generator (Astra) and the simulator.
`src/simulation/CityLoader.ts` reads it, validates it, fills in defaults and
normalises it into the types declared in `src/types/city.ts`.

The loader is **tolerant on input, strict on output**: anything the generator
omits gets a sensible derived default, and several fields accept more than one
spelling. Nothing here may be renamed without updating both the loader and this
document.

Units: metres, radians, simulation seconds, JPY. The city lies on the XZ plane
(Three.js, Y-up).

## Top level

```jsonc
{
  "meta":              { ... },        // optional, defaults derived from content
  "districts":         [ ... ],        // optional
  "groundZones":       [ ... ],        // optional; missing → uniform "medium" ground
  "roadNetwork":       { "nodes": [...], "edges": [...] },   // required
  "buildings":         [ ... ],        // required, >= 1
  "shelters":          [ ... ],        // required, >= 1
  "disasterScenarios": [ ... ]         // optional; a default earthquake is synthesised
}
```

Accepted aliases at the top level: `roads` / `roadGraph` for `roadNetwork`,
`evacuationShelters` for `shelters`, `scenarios` / `disasters` for
`disasterScenarios`, `zones` for `groundZones`.

## Positions

Anywhere a position is expected, all of these are accepted and normalised to
`{ x, z }`:

```jsonc
[120, -40]            // [x, z]
[120, 0, -40]         // [x, y, z]  — y ignored
{ "x": 120, "z": -40 }
{ "x": 120, "y": 0, "z": -40 }
```

## `meta`

| field | type | default |
| --- | --- | --- |
| `name` | string | `"AOBA CITY"` |
| `version` | string | `"1.0.0"` |
| `generatedBy` | string | `"unknown"` |
| `bounds` | `{minX,maxX,minZ,maxZ}` | computed from buildings + roads with a 60 m margin |
| `simulationSeed` | number | `20260908` |

## `districts[]`

| field | type | default |
| --- | --- | --- |
| `id` | string | `district-<i>` |
| `name` | string | `District <i>` |
| `kind` \| `type` | `residential \| commercial \| business \| industrial \| mixed \| waterfront \| civic` | `mixed` |
| `center` \| `position` | position | centroid of member buildings, else origin |
| `radius` | number | `150` |

## `groundZones[]`

| field | type | default |
| --- | --- | --- |
| `id` | string | `ground-<i>` |
| `name` | string | `Zone <i>` |
| `groundType` \| `type` \| `soil` | `rock \| hard \| medium \| soft \| reclaimed` | `medium` |
| `amplification` | number | table lookup: rock 0.75, hard 0.9, medium 1.0, soft 1.35, reclaimed 1.7 |
| `polygon` \| `points` \| `boundary` | position[] (>= 3) | zone dropped with a warning |

A building's ground multiplier is the amplification of the first zone whose
polygon contains it, else `1.0`.

## `roadNetwork.nodes[]`

| field | type | default |
| --- | --- | --- |
| `id` | string | `n<i>` |
| `position` \| `pos` \| `p` | position | **required** |
| `kind` \| `type` | `intersection \| endpoint \| waypoint` | derived from degree |

## `roadNetwork.edges[]`

| field | type | default |
| --- | --- | --- |
| `id` | string | `e<i>` |
| `from` \| `a` \| `start` | node id | **required** |
| `to` \| `b` \| `end` | node id | **required** |
| `width` | number (m) | from `roadClass`: arterial 22, collector 14, local 8, alley 4 |
| `roadClass` \| `class` \| `type` | `arterial \| collector \| local \| alley` | derived from `width` |
| `lanes` | number | `max(1, round(width / 3.2))` |
| `length` | number | computed from node positions (always recomputed) |

Edges are undirected. Edges referencing unknown nodes are dropped with a
warning; duplicate edges between the same node pair are collapsed.

## `buildings[]`

| field | type | default |
| --- | --- | --- |
| `id` | string | `b<i>` |
| `name` | string | generated from use + index |
| `position` \| `center` | position | **required** |
| `rotation` \| `angle` \| `heading` | radians (degrees if `rotationDegrees`) | `0` |
| `footprint` \| `size` | `{width, depth}` or `[w, d]` | `{width: 12, depth: 10}` |
| `floors` \| `stories` | int | derived from `height / 3.2`, else `2` |
| `height` | number (m) | `floors * 3.2` (+ parapet for flat roofs) |
| `use` \| `type` \| `category` | see `BUILDING_USES` | `residential` |
| `constructionType` \| `structure` \| `material` | `wood \| lightSteel \| masonry \| rc \| steel \| prefab` | `wood` if ≤ 2 floors, `rc` if ≤ 8, else `steel` |
| `yearBuilt` \| `buildingAge` \| `year` | int year (an age in years is converted) | `1985` |
| `roofType` \| `roof` | `flat \| gable \| hip \| mono \| sawtooth \| dome` | `gable` for ≤ 2-floor wood, else `flat` |
| `seismicResistance` | 0..1 | derived from `yearBuilt` + `constructionType` |
| `collapseThreshold` | 0..1 | `0.72 + 0.2 * seismicResistance` |
| `replacementValue` | JPY | floor area × unit cost by construction type |
| `occupancy` | int | derived from floor area × use density |
| `populationProfile` | `{child, adult, elderly, mobilityImpaired}` fractions | use-specific default, renormalised |
| `fireIgnitionProbability` | 0..1 | `0.06` wood, `0.02` others |
| `districtId` \| `district` | district id | `null` |
| `nearestRoadNodeId` \| `roadNodeId` | node id | nearest node computed by the loader |

## `shelters[]`

| field | type | default |
| --- | --- | --- |
| `id` | string | `s<i>` |
| `name` | string | `Shelter <i>` |
| `position` | position | **required** |
| `capacity` | int | `500` |
| `kind` \| `type` | `park \| school \| gym \| civic \| hospital` | `civic` |
| `footprint` | `{width, depth}` | scaled from capacity |
| `roadNodeId` | node id | nearest node computed by the loader |

## `disasterScenarios[]`

| field | type | default |
| --- | --- | --- |
| `id` | string | `scenario-<i>` |
| `type` | `earthquake \| flood \| tsunami \| fire \| typhoon` | `earthquake` |
| `name` | string | `"Earthquake"` |
| `epicenter` \| `epicentre` | position | city centre offset by ~40 % of the extent |
| `depthKm` | number | `12` |
| `magnitude` | number | `7.1` |
| `baseIntensity` | number | `1.0` |
| `intensityFalloff` | number (per metre) | `0.0011` |
| `durationSeconds` | number | `40` |
| `aftershocks` | `[{time, intensityScale}]` | `[]` |

The first `earthquake` scenario is the one the EARTHQUAKE button runs.

## Validation

Errors (load fails): no buildings, no shelters, fewer than 2 road nodes, no road
edges, a building/shelter/node with an unparseable position, a road network in
which no shelter is reachable from any building.

Warnings (load continues): dropped edges, dropped ground zones, out-of-range
scalars (clamped), unknown enum values (mapped to the nearest known value),
buildings farther than 120 m from any road node.
