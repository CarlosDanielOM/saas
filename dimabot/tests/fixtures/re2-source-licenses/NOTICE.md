The generated `src/utils/re2_unicode_data.rs` derives native property and case
fold tables from node-RE2 1.27.0's vendored RE2 sources and wrapper binary and
Script_Extensions tables and category aliases from that package's `lib/` sources.

`RE2-BSD-3-Clause.txt` is copied byte for byte from
`node_modules/re2/vendor/re2/LICENSE`. `node-re2-BSD-3-Clause.txt` is copied byte
for byte from `node_modules/re2/LICENSE`. Retain both with redistributed derived
tables. The source files' RE2 Authors notices are covered by the retained RE2
license; the wrapper copyright holder is Eugene Lazutkin.

The wrapper header explicitly attributes its data to `@unicode/unicode-17.0.0`
and Unicode PropertyValueAliases.txt. `Unicode-LICENSE.txt` retains the existing
repository's Unicode License V3 notice. This is license attribution, not a claim
that native RE2 uses Unicode 17.0. The native vendored tables declare no Unicode
version. The generator records exact hashes for all source and license inputs.
