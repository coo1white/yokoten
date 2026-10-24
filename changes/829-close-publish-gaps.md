Fixed

The guard stops more ways an agent could publish without you: `gh api`, release workflows, `npm version`, `push.followTags`, `git update-ref` tags, `npx` release tools, other code hosts, and package, image and chart tools. A dry run and `--help` still pass (#829).
