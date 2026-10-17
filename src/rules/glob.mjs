// A glob, matched against a path relative to the repo root with forward slashes.
//
// `*` matches inside one name, `?` one character, `**/` any number of folders (none too),
// and a trailing `**` everything below. A glob with a slash is anchored at the root
// (`test/**` is the root's test folder); a glob without one matches a name in any folder
// (`*.test.*`).

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`);
}

/** A function that says whether a path matches any of the globs. */
export function matcher(globs) {
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((re) => re.test(path));
}
