# landing/

Bind-mounted stand-in for the Azure Files (SMB) `landing/` share
(rm04-spec D4). Upstream delivers usage files here.

No sample usage file is committed here: the actual feed format (CDR/ASN.1/
TAP vs. a delimited format) is `ratemgmt-code-standards.md` §3's Open item 1
— still undecided as of rm04. A fixture claiming to be "the" usage feed
format would misdirect whoever builds rm07's parser. This directory exists
so the bind mount and the worker's read/write access to it can be exercised
end to end (verification item 22) with an arbitrary placeholder file, not so
a specific format can be tested yet.
