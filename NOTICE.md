# Notice — data licensing

The MIT licence in [LICENSE](LICENSE) covers the **GIS Browser application source code
only**.

It does not cover, and cannot cover, the boundary data the application retrieves. That
data is published by third parties — Statistics Canada, Elections Canada, Natural
Resources Canada, provincial and territorial governments, and others — each under its own
terms. None of it is this project's to relicense.

## How the terms travel with the data

Licensing is not left to the user to reconstruct. For every boundary the application
handles, the terms follow it:

- **In the registry.** Each source records its licence, attribution and vintage, verified
  when the endpoint was added.
- **In the app.** The on-air credit is shown beside the export button, ready to paste into
  a lower third. A multi-source export lists every distinct licence it mixes.
- **In the file.** Every exported feature carries a `_provenance` block with the source
  name, endpoint URL, licence, attribution, vintage, the date it was indexed, the date its
  geometry was retrieved, and what simplification was applied. It is written per feature,
  so a boundary pulled out into another document keeps its history.

## Sources that declare no usable licence

Several publishers state `none`, `custom`, or nothing at all. Those are recorded as
**unconfirmed** rather than assumed to be open, and the app says so — in the source notes,
in the discovery review list, and in the exported file.

An unconfirmed licence is not permission. Check the terms of the specific source before
publishing or broadcasting anything derived from it.

## Sources known to be open

Several sources publish under the **Open Government Licence – Canada**, which permits
reuse with attribution. Statistics Canada boundary files carry the **Statistics Canada
Open Licence**. Natural Earth is public domain. The registry records which is which; the
`_provenance` block repeats it per feature.

---

If you are about to put a boundary on air, the questions worth answering are: which source
did it come from, what does that source's licence permit, and is that licence confirmed?
All three are in the exported file.
