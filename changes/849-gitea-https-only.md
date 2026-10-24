Internal

The Gitea adapter sends its token only over https. The check sits beside the fetch as
well as before the read. A read must also stay on the server's origin, so a plain-http
address or a path that points elsewhere never carries the token (#849).
