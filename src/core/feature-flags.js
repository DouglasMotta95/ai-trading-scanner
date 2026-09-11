export const DEFAULT_FLAGS={globalScanner:false,aiLayer:false,newsFilter:false,replay:false,shadowMode:true,multiPlatform:true,miniChart:true,notifications:true,strategyLab:true};
export async function getFlags(){const {featureFlags={}}=await chrome.storage.local.get('featureFlags');return{...DEFAULT_FLAGS,...featureFlags}}
export async function setFlag(key,value){const flags=await getFlags();flags[key]=Boolean(value);await chrome.storage.local.set({featureFlags:flags});return flags}
