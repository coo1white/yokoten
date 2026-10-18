Added

yokoten can ship as an npm package with zero dependencies. Once the owner publishes it,
`npx yokoten install` and `npx yokoten init` set it up. The package runs built
JavaScript from `dist/`, which `npm pack` makes. The repo still runs the `.ts` files
with no build. `npm run check-package` packs the package, installs the tarball, and runs
`install`, `init` and `doctor` (#31).
