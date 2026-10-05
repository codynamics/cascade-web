"""The APNs signing key must parse. Before this fix, _ec_scalar_from_pkcs8 raised
IndexError on every valid key, so no push notification was ever sent to anyone.

The key below is built in the test from a fixed number. It is not a real credential."""
import base64
import unittest

from monitor import pusher

D = 0x1F2E3D4C5B6A79880123456789ABCDEFFEDCBA98765432100112233445566778


def _tlv(tag: int, content: bytes) -> bytes:
    n = len(content)
    if n < 0x80:
        return bytes([tag, n]) + content
    size = (n.bit_length() + 7) // 8
    return bytes([tag, 0x80 | size]) + n.to_bytes(size, "big") + content


def _pkcs8_der(d: int, with_public_key: bool) -> bytes:
    oid_ec_public_key = bytes.fromhex("2A8648CE3D0201")
    oid_prime256v1 = bytes.fromhex("2A8648CE3D030107")
    ec_fields = _tlv(0x02, b"\x01") + _tlv(0x04, d.to_bytes(32, "big"))
    if with_public_key:
        x, y = pusher._scalar_mult(d, pusher._G)
        point = b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")
        ec_fields += _tlv(0xA1, _tlv(0x03, b"\x00" + point))
    ec_private_key = _tlv(0x30, ec_fields)
    algorithm = _tlv(0x30, _tlv(0x06, oid_ec_public_key) + _tlv(0x06, oid_prime256v1))
    return _tlv(0x30, _tlv(0x02, b"\x00") + algorithm + _tlv(0x04, ec_private_key))


def _pem(der: bytes) -> bytes:
    body = base64.b64encode(der)
    lines = [body[i:i + 64] for i in range(0, len(body), 64)]
    return b"-----BEGIN PRIVATE KEY-----\n" + b"\n".join(lines) + b"\n-----END PRIVATE KEY-----\n"


class ApnsKeyParse(unittest.TestCase):
    def test_der_key_with_public_key_field(self):
        self.assertEqual(pusher._ec_scalar_from_pkcs8(_pkcs8_der(D, True)), D)

    def test_der_key_without_public_key_field(self):
        self.assertEqual(pusher._ec_scalar_from_pkcs8(_pkcs8_der(D, False)), D)

    def test_pem_text_as_found_in_a_p8_file(self):
        self.assertEqual(pusher._ec_scalar_from_pkcs8(_pem(_pkcs8_der(D, True))), D)

    def test_pem_text_with_windows_line_endings(self):
        pem = _pem(_pkcs8_der(D, True)).replace(b"\n", b"\r\n")
        self.assertEqual(pusher._ec_scalar_from_pkcs8(pem), D)

    def test_provider_token_mints_from_base64_of_the_p8_file(self):
        secret = base64.b64encode(_pem(_pkcs8_der(D, True))).decode("ascii")
        token = pusher._mint_provider_jwt("KEYID12345", "TEAMID1234", secret)
        self.assertEqual(len(token.split(".")), 3)

    def test_provider_token_mints_from_base64_of_der(self):
        secret = base64.b64encode(_pkcs8_der(D, True)).decode("ascii")
        token = pusher._mint_provider_jwt("KEYID12345", "TEAMID1234", secret)
        self.assertEqual(len(token.split(".")), 3)

    def test_signature_is_valid_for_the_key(self):
        import hashlib
        digest = hashlib.sha256(b"header.payload").digest()
        sig = pusher._ecdsa_sign_p256(D, digest)
        r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
        n = pusher._N
        w = pow(s, -1, n)
        z = int.from_bytes(digest, "big")
        q = pusher._scalar_mult(D, pusher._G)
        point = pusher._point_add(pusher._scalar_mult(z * w % n, pusher._G),
                                  pusher._scalar_mult(r * w % n, q))
        self.assertEqual(point[0] % n, r)


if __name__ == "__main__":
    unittest.main()
