import { loadFamily, sourceAt, cleanup } from "./helper.js";
const staking="0xb63cac384247597756545b500253ff8e607a8020";
const gOHM="0x0ab87046fbb341d058f17cbc4c1133f25a20a52f";
const OHM="0x64aa3364f17a4d01c6f1751fd97c2bd3d7e7f1d5";
try {
 const {plugin}=await loadFamily("olympus");
 const v=plugin.identity.variants[0];
 const candidate={candidateKind:"olympus-staking",target:staking};
 const ev={phase:"complete",source:sourceAt(1),staking, gOHM, OHM,
  stakingCodeHash:"0x6c1ff3d80434554eea4896f01540b4f810e10ef4e5e68de15de530672bb9176a",
  gOhmCodeHash:"0x09cabd71e420dac57ffa1cc568893a32b683d2f98076570c1756e1ec14d13bb9",
  ohmCodeHash:"0xbbfa9eba3c06791a338705ffc5b6566e8b1cc70a570fc7ab798d71af4dc8bcdd",
  gOhmDecimals:18n, ohmDecimals:9n};
 console.log(v.decide({candidate,evidence:ev,step:2}));
} finally { cleanup(); }
