# Private demo data

Tiya's ZIP supplied a useful folder-based demo workflow, but no customer or car photos. Use consenting teammate images, not arbitrary online portraits. There is no automatic private-photo ingestion or mock success when credentials are missing.

Customer photos can stay in ignored `demo-data\customer-01` or another private folder. Choose them in the studio or pass explicit `--photo` arguments to `npm run cli`. `POV` and `PERSONALIZED` do not upload or send customer photos.

## Car catalog

The creator studio offers Toyota and Lexus vehicles only. The supported lineup includes Toyota 4Runner, bZ, Camry, Corolla, Corolla Cross, Crown, Crown Signia, GR86, GR Corolla, GR Supra, Highlander, Land Cruiser, Mirai, Prius, RAV4, Sequoia, Sienna, Tacoma and Tundra, plus Lexus ES, GX, IS, LC, LS, LX, NX, RC, RX, RZ and UX.

Select a car directly in **02 Choose your car**. Each supported choice uses its checked-in, coherent exterior/interior reference pair, so customers and operators do not upload car photographs.

The checked-in `vehicle-catalog` directory contains only images whose source metadata records an explicit reusable license. For advertising or generative use, operators must still confirm that the recorded license and any attribution/share-alike requirements fit the intended production. Official press-gallery access or public web visibility alone is not permission. A private operator pack under `.movie-data\catalog\<product-id>` may override a bundled pack for an exact trim or campaign.

For operator-managed catalog files instead of the UI:

Place a permitted, coherent vehicle reference set under `.movie-data\catalog` (or the configured `MOVIE_DATA_DIR\catalog`) and create `product.json` there:

```json
{
  "id": "team-demo-car",
  "version": 1,
  "name": "Team-approved demo vehicle",
  "make": null,
  "model": null,
  "exteriorColor": "Match the supplied vehicle photographs",
  "interiorColor": null,
  "appearance": "Describe only the vehicle that actually appears in the reference photographs.",
  "approvedClaims": [],
  "usagePermission": "Replace with the source and actual permission to use these images.",
  "images": [
    { "file": "front-three-quarter.jpg", "role": "front_three_quarter" },
    { "file": "side.jpg", "role": "side" },
    { "file": "interior.jpg", "role": "interior" }
  ]
}
```

Use two to eight unique images, including an interior reference, and plain filenames within the catalog folder. Do not copy the illustrative permission sentence as a substitute for real permission.

The `demo-car-v1` synthetic concept in Dwight's orchestrator is a separate media-service contract. It does not implicitly refer to this studio's real car catalog.
