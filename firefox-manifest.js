// The Firefox build reuses the Chrome manifest, swapping the debugger loader
// for one that rewrites responses with webRequest.filterResponseData.
export function firefoxManifest(manifest) {
  const { minimum_chrome_version, ...rest } = manifest;
  return {
    ...rest,
    permissions: [...manifest.permissions.filter(name => name !== 'debugger'), 'webRequest', 'webRequestBlocking', 'webRequestFilterResponse'],
    background: { scripts: ['background-firefox.js'], type: 'module' },
    action: { default_title: 'Surfd QoL — reload' },
    // 128 is the first release that runs content scripts in the page's own world.
    browser_specific_settings: { gecko: { id: 'surfd-qol@eduardr02.github.io', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } }
  };
}
