# GlobalEntity Company Verify

Verify EU **VAT**, **EORI** and **LEI** numbers and look up companies in **66 official business registers** from your GitHub workflows, powered by [GlobalEntity API](https://www.globalentityapi.com).

Typical uses:

- **Supplier / customer master data checks.** Keep a `suppliers.csv` in the repo and fail the pull request if someone adds an invalid VAT number.
- **Release gates for invoicing and e-commerce.** Confirm that your own company identifiers are still valid before you deploy.
- **Scheduled KYB re-checks.** Run nightly and get a job summary of every identifier that changed status.

## Quick start

1. Get an API key (`gea_live_…`) at [globalentityapi.com/pricing](https://www.globalentityapi.com/pricing).
2. Add it as a secret named `GLOBALENTITY_API_KEY` (Settings → Secrets and variables → Actions).
3. Add a step to your workflow:

```yaml
- uses: Intermediary-AS/globalentity-action@v1
  with:
    api-key: ${{ secrets.GLOBALENTITY_API_KEY }}
    type: vat
    country: DK
    number: '22756214'
```

## Check a whole supplier list on every pull request

`data/suppliers.csv` (comma or semicolon separated; `type` defaults to `vat`):

```csv
type,country,number,name
vat,DK,22756214,A.P. Møller - Mærsk
eori,,DK22756214,A.P. Møller - Mærsk
lei,,549300D2K6PKKKXVNN73,A.P. Møller - Mærsk
```

```yaml
name: Verify suppliers
on:
  pull_request:
    paths: ['data/suppliers.csv']
  schedule:
    - cron: '0 6 * * 1'

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Intermediary-AS/globalentity-action@v1
        with:
          api-key: ${{ secrets.GLOBALENTITY_API_KEY }}
          operation: verify-file
          file: data/suppliers.csv
```

Each invalid row is reported as an error annotation and the step fails. The job summary shows a table of every row.

## Operations

| `operation` | Purpose | Required inputs |
|---|---|---|
| `verify` (default) | Validate one VAT (EU VIES), EORI (EU customs) or LEI (GLEIF) | `type`, `number` (+ `country` for VAT without prefix) |
| `verify-file` | Validate every row of a CSV file | `file` |
| `search` | Search an official national register by name or registration number | `country`, `query` |
| `resolve` | Build a golden record with stable id and identity Trust Score (0–100) | `country` + `number` or `name` |

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | — | **Required.** GlobalEntity API key. Always pass it from a secret. |
| `operation` | `verify` | `verify`, `verify-file`, `search` or `resolve`. |
| `type` | `vat` | `vat`, `eori` or `lei` (operation `verify`). |
| `country` | — | ISO code (e.g. `DK`) for VAT; country name or code (e.g. `Norway`) for search/resolve. |
| `number` | — | VAT / EORI / LEI (verify) or registration number / LEI (resolve). |
| `query` | — | Company name or registration number (search). |
| `name` | — | Company name (resolve; optional hint for LEI). |
| `file` | — | CSV path with a header row containing `number` and usually `type`, `country` (verify-file). |
| `fail-on-invalid` | `true` | Fail when an identifier is confirmed invalid, or search finds nothing. |
| `fail-on-unknown` | `false` | Fail when the official source could not confirm validity (e.g. VIES temporarily down). |
| `api-url` | `https://www.globalentityapi.com` | API base URL. |
| `timeout-seconds` | `30` | Timeout per request. Network errors and 5xx responses are retried twice. |

## Outputs

| Output | Description |
|---|---|
| `valid` | `true`, `false` or `unknown`. For `verify-file`: `false` if any row is invalid. |
| `name`, `address` | Registered name and address (first match). |
| `entity-id`, `trust-score` | Golden record id and Trust Score (resolve). |
| `count` | Companies found (search) or rows checked (verify-file). |
| `invalid-count`, `unknown-count` | Row counts (verify-file). |
| `result` | Full JSON response, or a JSON array of row results for `verify-file`. |

Example of using the outputs:

```yaml
- id: vat
  uses: Intermediary-AS/globalentity-action@v1
  with:
    api-key: ${{ secrets.GLOBALENTITY_API_KEY }}
    number: DK22756214
    fail-on-invalid: false
- run: echo "Valid=${{ steps.vat.outputs.valid }} Name=${{ steps.vat.outputs.name }}"
```

## Data and privacy

The action only sends the identifiers you give it to `api-url`, over HTTPS, with your API key in the `x-api-key` header. Data comes from official sources (national registers, EU VIES, EU EORI/EOS, GLEIF). The Trust Score is an identity confidence score, **not** a credit rating.

- Privacy policy: <https://www.globalentityapi.com/privacy>
- Terms: <https://www.globalentityapi.com/terms>
- API documentation: <https://www.globalentityapi.com/docs>

## Support

Open an [issue](https://github.com/Intermediary-AS/globalentity-action/issues) or email [contact@intermediary.no](mailto:contact@intermediary.no).

## License

The action code is MIT licensed (see [LICENSE](LICENSE)). Use of GlobalEntity API is subject to the [API terms](https://www.globalentityapi.com/terms).

Published by **Intermediary AS** (org. no. 925 615 471), Stavanger, Norway.
