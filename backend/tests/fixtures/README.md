# Synthetic VW protocol fixtures

Every value here is invented for offline characterization. `TESTVIN0000000000`,
`synthetic-*` tokens/IDs, and `example.invalid` identities are deliberately
unusable. Do not commit live VW responses, credentials, session cookies, VINs,
location history or device identifiers. Build new minimal fixtures by hand from
the fields the test actually needs. The test preload replaces `fetch` before
production modules load, and its queue rejects any unexpected request.
