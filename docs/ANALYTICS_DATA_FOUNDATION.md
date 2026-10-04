# Analytics data foundation

Phase 5 records the existing Phase 2 `VehicleState` without claiming that the VW source supplies continuous telemetry. Analytics calculations, trip inference, efficiency models, and UI are future work. `vehicle_observations` keeps meaningful state/source-evidence changes; `telemetry_samples` keeps at most one eligible point per 15-minute bucket. The first eligible point in a bucket is retained, so a sample is neither a bucket average nor a guarantee that the vehicle was observed throughout it. Both are sparse, polling-dependent data.

## Available observations

The current VW adapter can represent battery SOC, estimated range, charge status/power, plug state, target SOC, odometer, climate activity and target temperature, remaining climate time, lock/closure status, last parked location, and local/source freshness timestamps. Every measurement is nullable or may be `unknown`; capability support is recorded separately. The historical table preserves the whole domain state, including those distinctions and source times. The coarse table projects only selected numeric and activity fields. A missing value stays missing; it is never replaced with zero or inferred from a command request.

The existing status API and adapter do **not** establish actual traction energy consumed, trip speed trace, outside temperature, measured cabin temperature, HVAC electrical energy, elevation, road grade, or route conditions as reliable domain fields. A climate setpoint is a requested target, not measured cabin temperature. Charge power is a reported charging value, not driving energy use. Estimated range is the vehicle's estimate, not distance traveled. Last parked coordinates are not a driven route. These inputs would require verified future VW fields or additional consented data sources (for example weather and route/elevation data), with provenance and timestamps.

| Future factor                         | Present evidence                                              | Current limit                                                                                   |
| ------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Battery/range trend                   | SOC and estimated range at sparse reads                       | Missing/stale source updates and vehicle-estimated range limit interpretation.                  |
| Charging history                      | Charge/plug state, reported charge power, target SOC          | Can identify observed transitions; cannot integrate delivered kWh reliably from sparse samples. |
| Climate use                           | Activity, setpoint, remaining time                            | Does not measure cabin temperature or HVAC energy draw.                                         |
| Trip length                           | Odometer deltas, source/local times, optional parked position | May span multiple trips and include unobserved charging; no trip boundary or route trace today. |
| Speed, outside temperature, elevation | None in the current domain model                              | Need new verified sources and temporal/route alignment.                                         |
| Actual mi/kWh                         | No actual kWh consumed                                        | Cannot calculate a defensible actual efficiency value yet.                                      |

## Later trip and efficiency work

A later pipeline could propose candidate trips from increasing odometer readings bracketed by parked/location, charging, or ignition evidence when those events are actually observed. It must attach confidence and gaps, avoid treating one sparse odometer delta as one trip, and distinguish local fetch time from source capture time. Event generation and trip segmentation are intentionally absent here. Retention/downsampling should be chosen after measuring real observation frequency; full duplicate snapshots on every minute-long poll are avoided by the fingerprint.

Estimating energy from SOC percentage changes requires a usable battery capacity at that time, battery health, charging/regen context, and sufficiently aligned endpoints. SOC is rounded and may change while parked; usable capacity is vehicle- and condition-dependent. Multiplying an SOC delta by a nominal capacity is at best an explicitly labeled approximation, not an observed kWh figure. mi/kWh modeling needs trip distance and verified consumed energy, plus synchronized covariates: outside temperature, speed distribution, trip length, elevation/grade, HVAC usage and setpoint, initial SOC, route differences, traffic, and data freshness. Comparisons should control for these confounders and report sample size and uncertainty.

The future goal includes insights such as “Under comparable conditions, reducing cabin setpoint 2°F is associated with approximately +0.08 mi/kWh.” That number is an **illustrative target phrasing, not a finding or a computed effect**. BuzzKey cannot estimate it from the currently available data. No regression or statistical model is implemented in Phase 5.

## Control evidence provenance

Charging/climate/wake commands remain intent/evidence records, not fabricated telemetry. Actual climate reads now supply category activity/target/remaining time with an optional local fetch timestamp, which status-only polls preserve. The meaningful-state fingerprint ignores that fetch timestamp, as it already ignores general local freshness, so unchanged climate reads do not generate duplicate observations. Camp intent and expiry are separate SQLite session fields and cannot establish continuous HVAC usage, measured cabin temperature, energy consumption or physical execution time. See [CONTROL_CUTOVER.md](CONTROL_CUTOVER.md).
