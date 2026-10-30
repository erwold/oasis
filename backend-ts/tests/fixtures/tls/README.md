A self-signed certificate for the synthetic name `pinned.example.test` (no real host, no trust anywhere): the test
of the pinned transport serves it from a loopback TLS server and checks that a connection made to the address is
verified against the name. Nothing else uses it. Regenerate with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout pinned.example.test.key -out pinned.example.test.crt -days 7300 \
      -subj "/CN=pinned.example.test" -addext "subjectAltName=DNS:pinned.example.test"
