/**
 * The keyless pattern the documentation tells people to write.
 *
 * The strategy is a factory rather than an object precisely so that the signer is
 * built only when something is about to settle. When it cannot be built the
 * factory declines, and every read - discovery, status, doctor - still has to
 * work, with the Agent, the registry URL and the Service endpoints intact.
 *
 * The real form of this reads a signing key out of the environment. This one is
 * switched by a global instead, because what is under test is that a declining
 * factory is handled, not why it declined - and inventing a signing-key variable
 * for a fixture would put a name in the tracked environment contract that no
 * consumer of this package will ever set.
 */
export default {
  agent: "0x1f6f797edc2eecb02bd54009b805fb2e99f80542",
  registryUrl: "http://registry.example",
  services: [
    {
      serviceId: "0x7461622e70726f6f662d73657276696365000000000000000000000000000000",
      name: "tab.proof-service",
      endpoint: "http://service.example",
    },
  ],
  strategies: [
    () => {
      if (globalThis.__tabKeylessFixtureSigner !== true) return undefined;
      return {
        id: "fixture-usdc",
        chainKeys: [1n],
        supports: () => true,
        quote: async () => ({ ok: true, value: {} }),
        settle: async () => ({ ok: true, value: {} }),
        watchHint: () => ({ chainKey: 1n, txHash: "0x" }),
      };
    },
  ],
};
