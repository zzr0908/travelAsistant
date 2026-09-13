# Map test fixtures

`geoapify-positron-style.json` is the Geoapify Positron style response obtained on 2026-09-08 from `https://maps.geoapify.com/v1/styles/positron/style.json`. API key values are replaced with `REDACTED`. It is used to exercise rewriting of the real nested resource structure; it is not evidence that the production browser has rendered the map.

The style retains its original attribution and metadata. See [Geoapify map documentation](https://apidocs.geoapify.com/docs/maps/) for applicable attribution requirements.

`geoapify-florence-walk.json` is a real Geoapify walking response acquired on 2026-09-08 for Ponte Vecchio → Piazza Santa Croce. It contains 756 meters, 731.992 seconds and 47 vertices. It tests the routing response contract, including array-valued country codes; replay alone is not independent route validation. Acquisition evidence: `docs/qa/map-integration/route-shape-probe.json`.

`geoapify-search-fallback.json` preserves the 2026-09-08 geocoding and nearby category responses used to investigate seven initially unresolved acceptance inputs. API keys are excluded. The replay tests keep unsupported matches unresolved, including a same-name bus stop that returned a museum and a covered bridge represented only as a roof. Provenance and fixed pre-query expectations are in `docs/qa/map-integration/place-sample-inputs.json`, `place-sample-geocode-probe.json` and `place-sample-bridge-nearby.json`. See [Geocoding](https://apidocs.geoapify.com/docs/geocoding/) and [Places](https://apidocs.geoapify.com/docs/places/) API documentation.

All other map features constructed directly in `maps.test.ts` are test data, not verified places or travel suggestions. Keep raw-service replay, live service results, independent identity review and browser verification separate.
