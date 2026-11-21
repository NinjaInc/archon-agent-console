import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests: real ES256 keys, real CBOR
 * attestation ("none" format) and real assertion signatures, so the server's
 * verification code runs for real instead of being mocked.
 */

function cborLength(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
}
const cborText = (text: string) => Buffer.concat([cborLength(3, text.length), Buffer.from(text)]);
const cborBytes = (bytes: Buffer) => Buffer.concat([cborLength(2, bytes.length), bytes]);
const cborMap = (...entries: Buffer[]) => Buffer.concat([cborLength(5, entries.length / 2), ...entries]);
// Small signed ints used by the COSE key map.
const cborInt = (value: number) => (value >= 0 ? Buffer.from([value]) : Buffer.from([0x20 | (-1 - value)]));

const b64url = (buffer: Buffer) => buffer.toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

export class VirtualAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  signCount = 0;

  constructor(private readonly rpId: string, private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  /** Answers navigator.credentials.create(). `originOverride` simulates a phishing origin. */
  register(challenge: string, options: { originOverride?: string; userVerified?: boolean } = {}) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin: options.originOverride ?? this.origin, crossOrigin: false }),
    );
    const coseKey = cborMap(
      cborInt(1), cborInt(2), // kty: EC2
      cborInt(3), cborInt(-7), // alg: ES256
      cborInt(-1), cborInt(1), // crv: P-256
      cborInt(-2), cborBytes(Buffer.from(this.publicJwk.x, 'base64url')),
      cborInt(-3), cborBytes(Buffer.from(this.publicJwk.y, 'base64url')),
    );
    const flags = 0x01 | 0x40 | (options.userVerified === false ? 0 : 0x04); // UP | AT | UV
    const counter = Buffer.alloc(4);
    const credentialIdLength = Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([flags]), counter, Buffer.alloc(16), credentialIdLength, this.credentialId, coseKey]);
    const attestationObject = cborMap(cborText('fmt'), cborText('none'), cborText('attStmt'), cborMap(), cborText('authData'), cborBytes(authData));

    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
    };
  }

  /** Answers navigator.credentials.get(). Pass `counter` to replay an old value. */
  assert(challenge: string, options: { originOverride?: string; counter?: number } = {}) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: options.originOverride ?? this.origin, crossOrigin: false }),
    );
    this.signCount = options.counter ?? this.signCount + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x01 | 0x04]), counter]); // UP | UV
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);

    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from('archon-console-owner')),
      },
    };
  }
}
