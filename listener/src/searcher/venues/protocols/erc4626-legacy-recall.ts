import { ADDR } from "../../../shared/constants/addresses.js";

/**
 * The former hardcoded standard-ERC4626 vault seeds, retained ONLY as the
 * expected-recall answer key for the no-seed replay acceptance. This list is
 * NEVER a discovery candidate source (that would be circular self-seeding);
 * discovery must independently re-enumerate each address from DEX/event flow
 * plus the evidence cache. A discovered set that is a strict superset of this
 * list is the recall pass; a missing entry is a recall failure.
 */
export const ERC4626_LEGACY_RECALL_VAULTS: readonly {
  readonly address: string;
  readonly asset: string;
}[] = Object.freeze([
  { address: ADDR.SUSDS, asset: ADDR.USDS },
  { address: ADDR.WSTUSR, asset: ADDR.USR },
  { address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB", asset: ADDR.USDC },
  { address: "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa", asset: ADDR.USDT },
  { address: "0xac3E018457B222d93114458476f3E3416Abbe38F", asset: ADDR.FRXETH },
  { address: "0x7Bc3485026Ac48b6cf9BaF0A377477Fff5703Af8", asset: ADDR.USDT },
  { address: "0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E", asset: ADDR.USDC },
  { address: "0xc441d0Bd70DBcF711f4BbA19AeA3deff47ce1C48", asset: ADDR.USDC },
  { address: "0x395dA89bDb9431621A75DF4e2E3B993Acc2CaB3D", asset: ADDR.WETH },
  { address: "0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc", asset: ADDR.USDC },
  { address: "0xe3DA4B83C9dd4c4D185ecE42077462b3F35c454a", asset: ADDR.USDC },
  { address: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", asset: ADDR.CRVUSD },
  { address: "0x6aD038cA6C04e885630851278ca0a856Ad9a66Cc", asset: ADDR.USDC },
  { address: "0x6d134cAAD0CA29Cd6ea145f6C0DC766076690547", asset: ADDR.USDT },
  { address: "0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7", asset: "0x23238f20b894f29041f48D88eE91131C395Aaa71" },
  { address: "0xC255910618158F48FA461874471Aa24AEfbDC23A", asset: "0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5" },
  { address: "0xC71Ea051a5F82c67ADcF634c36FFE6334793D24C", asset: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f" },
  { address: "0x43680aBF18cf54898Be84C6eF78237CFBD441883", asset: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0" },
  { address: "0x4825eFF24F9B7b76EEAFA2ecc6A1D5dFCb3c1c3f", asset: ADDR.USDC },
  { address: "0xB8280955aE7b5207AF4CDbdCd775135Bd38157fE", asset: ADDR.USDT },
]);
