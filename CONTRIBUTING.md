# Contributing

## How it works

During `astro dev`, the integration maps rendered elements to their source ranges, loads an in-browser editor, and sends validated changes to a local endpoint that updates those ranges. Production builds do not register the editor or source-write endpoint.

## Development

Install the development dependencies:

```sh
npm ci
```

Run the unit tests and TypeScript build:

```sh
npm run check:unit
```

Run the full test and coverage gate:

```sh
npm run check
```
