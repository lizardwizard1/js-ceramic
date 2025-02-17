import { CeramicApi, IpfsApi } from '@ceramicnetwork/common'
import { createIPFS } from '@ceramicnetwork/ipfs-daemon'
import { TileDocument } from '@ceramicnetwork/stream-tile'
import { DID } from 'dids'
import { Wallet } from 'ethers'
import { Ed25519Provider } from 'key-did-provider-ed25519'
import * as KeyDidResolver from 'key-did-resolver'
import { randomBytes } from '@stablelib/random'
import { SiweMessage, Cacao } from 'ceramic-cacao'
import { createCeramic } from '../create-ceramic.js'
import {
  ModelInstanceDocument,
  ModelInstanceDocumentMetadata,
} from '@ceramicnetwork/stream-model-instance'
import { StreamID } from '@ceramicnetwork/streamid'
import { Model, ModelAccountRelation, ModelDefinition } from '@ceramicnetwork/stream-model'

const getModelDef = (name: string): ModelDefinition => ({
  name: name,
  accountRelation: ModelAccountRelation.LIST,
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      myData: {
        type: 'integer',
        maximum: 10000,
        minimum: 0,
      },
    },
    required: ['myData'],
  },
})

const MODEL_DEFINITION = getModelDef('MyModel')
const MODEL_DEFINITION_2 = getModelDef('MyModel_2')
const CONTENT0 = { myData: 0 }
const CONTENT1 = { myData: 1 }

const addCapToDid = async (wallet, didKey, resource) => {
  // Create CACAO with did:key as aud
  const siweMessage = new SiweMessage({
    domain: 'service.org',
    address: wallet.address,
    chainId: '1',
    statement: 'I accept the ServiceOrg Terms of Service: https://service.org/tos',
    uri: didKey.id,
    version: '1',
    nonce: '23423423',
    issuedAt: new Date().toISOString(),
    resources: [resource],
  })
  // Sign CACAO with did:pkh
  const signature = await wallet.signMessage(siweMessage.toMessage())
  siweMessage.signature = signature
  const capability = Cacao.fromSiweMessage(siweMessage)
  // Create new did:key with capability attached
  const didKeyWithCapability = didKey.withCapability(capability)
  await didKeyWithCapability.authenticate()
  return didKeyWithCapability
}

describe('CACAO Integration test', () => {
  let ipfs: IpfsApi
  let ceramic: CeramicApi
  let wallet: Wallet
  let didKey: DID
  let didKeyWithParent: DID
  let didKey2: DID
  let wallet2: Wallet
  let METADATA: ModelInstanceDocumentMetadata
  let MODEL_STREAM_ID_2: StreamID

  beforeAll(async () => {
    process.env.CERAMIC_ENABLE_EXPERIMENTAL_INDEXING = 'true'

    ipfs = await createIPFS()
    ceramic = await createCeramic(ipfs)
    // Create a did:pkh for the user
    wallet = Wallet.fromMnemonic(
      'despair voyage estate pizza main slice acquire mesh polar short desk lyrics'
    )
    wallet2 = Wallet.fromMnemonic(
      'gap heavy cliff slab victory despair wage tiny physical tray situate primary'
    )
    // Create did:key for the dApp
    const didKeyProvider = new Ed25519Provider(randomBytes(32))
    didKey = new DID({ provider: didKeyProvider, resolver: KeyDidResolver.getResolver() })
    await didKey.authenticate()
    didKeyWithParent = new DID({
      provider: didKeyProvider,
      resolver: KeyDidResolver.getResolver(),
      parent: `did:pkh:eip155:1:${wallet.address}`,
    })
    await didKeyWithParent.authenticate()

    const didKeyProvider2 = new Ed25519Provider(randomBytes(32))
    didKey2 = new DID({ provider: didKeyProvider2, resolver: KeyDidResolver.getResolver() })
    await didKey2.authenticate()

    // Create models, get streamids
    const model = await Model.create(ceramic, MODEL_DEFINITION)
    const model2 = await Model.create(ceramic, MODEL_DEFINITION_2)
    MODEL_STREAM_ID_2 = model2.id
    METADATA = { model: model.id }
  }, 120000)

  afterAll(async () => {
    await ipfs.stop()
    await ceramic.close()
  }, 30000)

  describe('Updates without CACAO should fail', () => {
    test('can not update with stream without capability', async () => {
      // Create a determinstic tiledocument owned by the user
      const deterministicDocument = await TileDocument.deterministic(ceramic, {
        deterministic: true,
        family: 'testCapabilities1',
        controllers: [`did:pkh:eip155:1:${wallet.address}`],
      })

      await expect(
        deterministicDocument.update({ foo: 'bar' }, null, {
          asDID: didKey,
          anchor: false,
          publish: false,
        })
      ).rejects.toThrowError(/invalid_jws: not a valid verificationMethod for issuer:/)
    }, 30000)

    test('can not create new stream without capability', async () => {
      const family = 'testFamily1'
      await expect(
        TileDocument.create(
          ceramic,
          { foo: 'bar' },
          {
            family: `${family}`,
            controllers: [`did:pkh:eip155:1:${wallet.address}`],
          },
          {
            asDID: didKey,
            anchor: false,
            publish: false,
          }
        )
      ).rejects.toThrowError(/invalid_jws: not a valid verificationMethod for issuer:/)
    }, 30000)
  })

  describe('Resources using StreamId', () => {
    test('can update with streamId in capability', async () => {
      // Create a determinstic tiledocument owned by the user
      const deterministicDocument = await TileDocument.deterministic(ceramic, {
        deterministic: true,
        family: 'testCapabilities1',
        controllers: [`did:pkh:eip155:1:${wallet.address}`],
      })
      const streamId = deterministicDocument.id
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://${streamId.toString()}`
      )

      await deterministicDocument.update({ foo: 'bar' }, null, {
        asDID: didKeyWithCapability,
        anchor: false,
        publish: false,
      })

      expect(deterministicDocument.content).toEqual({ foo: 'bar' })
    }, 30000)

    test('fails to update if cacao issuer is not document controller', async () => {
      // Create a determinstic tiledocument owned by the user
      const deterministicDocument = await TileDocument.deterministic(ceramic, {
        deterministic: true,
        family: 'testCapabilities2',
      })
      const streamId = deterministicDocument.id
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://${streamId.toString()}`
      )

      await expect(
        deterministicDocument.update({ foo: 'baz' }, null, {
          asDID: didKeyWithCapability,
          anchor: false,
          publish: false,
        })
      ).rejects.toThrow(/invalid_jws/)
    }, 30000)

    test('fails to update using capability with invalid resource', async () => {
      // Create a determinstic tiledocument owned by the user
      const deterministicDocument = await TileDocument.deterministic(ceramic, {
        deterministic: true,
        family: 'testCapabilities3',
        controllers: [`did:pkh:eip155:1:${wallet.address}`],
      })
      const badDidKeyWithCapability = await addCapToDid(wallet, didKey, `ceramic://abcdef`)

      await expect(
        deterministicDocument.update({ foo: 'baz' }, null, {
          asDID: badDidKeyWithCapability,
          anchor: false,
          publish: false,
        })
      ).rejects.toThrowError(
        'Capability does not have appropriate permissions to update this Stream'
      )
    }, 30000)
  })

  describe('Model instance stream with resources using model', () => {
    test('fails to create using capability with wrong model resource', async () => {
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://*?model=${MODEL_STREAM_ID_2.toString()}`
      )

      ceramic.did = didKeyWithCapability

      await expect(
        ModelInstanceDocument.create(ceramic, CONTENT0, {
          model: METADATA.model,
          controller: `did:pkh:eip155:1:${wallet.address}`,
        })
      ).rejects.toThrowError(
        'Capability does not have appropriate permissions to update this Stream'
      )
    }, 30000)

    test('fails to update using capability with wrong model resource', async () => {
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://*?model=${METADATA.model.toString()}`
      )

      ceramic.did = didKeyWithCapability

      const doc = await ModelInstanceDocument.create(ceramic, CONTENT0, {
        model: METADATA.model,
        controller: `did:pkh:eip155:1:${wallet.address}`,
      })

      const didKeyWithBadCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://*?model=${MODEL_STREAM_ID_2.toString()}`
      )

      ceramic.did = didKeyWithBadCapability

      await expect(
        doc.replace(CONTENT1, {
          asDID: didKeyWithBadCapability,
          anchor: false,
          publish: false,
        })
      ).rejects.toThrowError(
        'Capability does not have appropriate permissions to update this Stream'
      )
    }, 30000)

    test('fails to create using capability with empty model resource', async () => {
      const didKeyWithCapability = await addCapToDid(wallet, didKey, `ceramic://*?model=`)
      ceramic.did = didKeyWithCapability

      await expect(
        ModelInstanceDocument.create(ceramic, CONTENT0, {
          model: METADATA.model,
          controller: `did:pkh:eip155:1:${wallet.address}`,
        })
      ).rejects.toThrowError(
        'Capability does not have appropriate permissions to update this Stream'
      )
    }, 30000)

    test('fails to create if cacao issuer is not document controller using model resource', async () => {
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey2,
        `ceramic://*?model=${METADATA.model.toString()}`
      )
      ceramic.did = didKeyWithCapability

      await expect(
        ModelInstanceDocument.create(ceramic, CONTENT0, {
          model: METADATA.model,
          controller: `did:key:z6MkwDAbu8iqPb2BbMs7jnGGErEu4U5zFYkVxWPb4zSAcg39#z6MkwDAbu8iqPb2BbMs7jnGGErEu4U5zFYkVxWPb4zSAcg39`,
        })
      ).rejects.toThrow(/invalid_jws/)
    }, 30000)

    test('fails to update if cacao issuer is not document controller using model resource', async () => {
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://*?model=${METADATA.model.toString()}`
      )

      ceramic.did = didKeyWithCapability

      const doc = await ModelInstanceDocument.create(ceramic, CONTENT0, {
        model: METADATA.model,
        controller: `did:pkh:eip155:1:${wallet.address}`,
      })

      const didKeyWithBadCapability = await addCapToDid(
        wallet2,
        didKey2,
        `ceramic://*?model=${METADATA.model.toString()}`
      )

      await expect(
        doc.replace(CONTENT1, {
          asDID: didKeyWithBadCapability,
          anchor: false,
          publish: false,
        })
      ).rejects.toThrow(/Failed/)
    }, 30000)

    test('can create stream with model resource', async () => {
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://*?model=${METADATA.model.toString()}`
      )
      ceramic.did = didKeyWithCapability

      const doc = await ModelInstanceDocument.create(ceramic, CONTENT0, {
        model: METADATA.model,
        controller: `did:pkh:eip155:1:${wallet.address}`,
      })

      expect(doc.content).toEqual(CONTENT0)
      expect(doc.metadata.controller).toEqual(`did:pkh:eip155:1:${wallet.address}`)
      expect(doc.metadata.model.toString()).toEqual(METADATA.model.toString())
    }, 30000)

    test('can create and update stream with model resource', async () => {
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://*?model=${METADATA.model.toString()}`
      )
      ceramic.did = didKeyWithCapability

      const doc = await ModelInstanceDocument.create(ceramic, CONTENT0, {
        model: METADATA.model,
        controller: `did:pkh:eip155:1:${wallet.address}`,
      })

      await doc.replace(CONTENT1, {
        asDID: didKeyWithCapability,
        anchor: false,
        publish: false,
      })

      expect(doc.content).toEqual(CONTENT1)
    }, 30000)
  })

  describe('Resources using wildcard', () => {
    test('update using capability with wildcard * resource', async () => {
      // Create a determinstic tiledocument owned by the user
      const deterministicDocument = await TileDocument.deterministic(ceramic, {
        deterministic: true,
        family: 'testfamily',
        controllers: [`did:pkh:eip155:1:${wallet.address}`],
      })
      const didKeyWithCapability = await addCapToDid(wallet, didKey, `ceramic://*`)

      await deterministicDocument.update({ foo: 'bar' }, null, {
        asDID: didKeyWithCapability,
        anchor: false,
        publish: false,
      })

      expect(deterministicDocument.content).toEqual({ foo: 'bar' })
    }, 30000)

    test('create the c', async () => {
      const didKeyWithCapability = await addCapToDid(wallet, didKey, `ceramic://*`)

      const doc = await TileDocument.create(
        ceramic,
        { foo: 'bar' },
        {
          controllers: [`did:pkh:eip155:1:${wallet.address}`],
        },
        {
          asDID: didKeyWithCapability,
          anchor: false,
          publish: false,
        }
      )

      expect(doc.content).toEqual({ foo: 'bar' })
      expect(doc.metadata.controllers).toEqual([`did:pkh:eip155:1:${wallet.address}`])
    }, 30000)
  })

  describe('Ceramic dids instance with capability/parent', () => {
    test('can update tile stream with streamId in capability', async () => {
      ceramic.did = didKeyWithParent
      // Create a determinstic tiledocument owned by the user
      const deterministicDocument = await TileDocument.deterministic(ceramic, {
        deterministic: true,
        family: 'testCapabilities1',
      })
      const streamId = deterministicDocument.id
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://${streamId.toString()}`
      )
      ceramic.did = didKeyWithCapability

      await deterministicDocument.update({ foo: 'bar' }, null, {
        anchor: false,
        publish: false,
      })

      expect(deterministicDocument.content).toEqual({ foo: 'bar' })
    }, 30000)

    test('can create and update new model stream with model resource', async () => {
      const didKeyWithCapability = await addCapToDid(
        wallet,
        didKey,
        `ceramic://*?model=${METADATA.model.toString()}`
      )

      ceramic.did = didKeyWithCapability
      const doc = await ModelInstanceDocument.create(ceramic, CONTENT0, {
        model: METADATA.model,
      })

      expect(doc.content).toEqual(CONTENT0)
      expect(doc.metadata.controller).toEqual(`did:pkh:eip155:1:${wallet.address}`)
      expect(doc.metadata.model.toString()).toEqual(METADATA.model.toString())

      await doc.replace(CONTENT1, {
        anchor: false,
        publish: false,
      })

      expect(doc.content).toEqual(CONTENT1)
    }, 30000)

    test('create with wildcard * resource', async () => {
      const didKeyWithCapability = await addCapToDid(wallet, didKey, `ceramic://*`)
      ceramic.did = didKeyWithCapability
      const doc = await TileDocument.create(
        ceramic,
        { foo: 'bar' },
        {},
        {
          anchor: false,
          publish: false,
        }
      )

      expect(doc.content).toEqual({ foo: 'bar' })
      expect(doc.metadata.controllers).toEqual([`did:pkh:eip155:1:${wallet.address}`])
    }, 30000)
  })
})
