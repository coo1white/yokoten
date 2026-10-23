Security

The board page is at `http://<repo>.localhost:<port>/` (#693).
`<repo>` is the folder name, made safe for a hostname.
The port stays the same for this repo.
The first visit uses `?token=` and sets an HttpOnly Secure cookie.
That visit then opens the page without the token.
Later visits use the cookie.
A wrong host, a missing cookie or a wrong cookie is refused.
