Fixed

The privacy check no longer flags common web strings. A retina image name such as
`logo@2x.png` is not an email address, and a version token in a user agent, such as
`Chrome/120.0.0.0`, is not an IP address. A real address on the same line, or an IP
after `http://`, is still caught. The guide now says what the IP rule covers: IPv4,
private ranges included; IPv6 is not checked (#245).
