Security

`yokoten check --pr` says when a change makes the rules looser, or moves a hard line, and that fails the check (#697). A changed file the guard imports, a moved test with a changed helper, and a refusal the reader cannot reach fail it too. A changed top-level test declaration, or a refusal after a constant exit, fails it too.
