# 0011 Four languages, under docs/i18n

Status: accepted; changes the language list and paths of [0007](0007-languages.md)
Date: 2026-10-20 (UTC)

## Context

[0007](0007-languages.md) gave users three languages: English, Chinese and Japanese.
Its Chinese is Simplified, as read in mainland China. Readers in Taiwan use Traditional
characters and different words for many dev terms, such as 軟體, 專案 and 預設.
A character conversion of the Simplified text reads wrong to them.

Adding `docs/zh-TW/` put eight entries in `docs/`. The folder cap is seven.

## Decision

On 2026-10-20 the owner chose four languages for users:

- English, the source;
- 简体中文 (`zh-CN`);
- 繁體中文 (`zh-TW`), written in Taiwan usage, not converted from `zh-CN`;
- 日本語 (`ja`).

Translations live under `docs/i18n/<lang>/`, for example `docs/i18n/zh-TW/README.md`.
Every README's language line links all four.

The rest of 0007 holds: development is in English, English is the source, and a
translation never adds to it.

## Options not taken

- **Convert zh-CN to Traditional characters.** Cheap, but the words stay mainland
  words, and Taiwan readers notice at once.
- **Raise the folder cap, or exempt `docs/`.** The cap keeps folders findable. One
  folder for all translations also gives the next language an obvious place.

## Consequences

- Links into the translations change once. The site's links to the Chinese guide must
  follow the move.
- A new language is a new folder under `docs/i18n/`, not a new entry in `docs/`.
- `zh-TW` needs a reader in Taiwan to check it, as Japanese does.
