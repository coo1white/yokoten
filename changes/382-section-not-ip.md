Fixed

The privacy check no longer reports spec section numbers and versions as IP addresses
(#382). A dotted quad after `§`, "section", "v", "version", or a document name such as
`MS-OVBA`, `RFC 7230`, `ECMA-376` or `ISO 32000-1` is skipped. So is one with a tag such
as `-beta`, and a range of section numbers such as `2.3.1.15 to 2.3.1.17`. A real address
is still reported, and so is a range of real addresses.
