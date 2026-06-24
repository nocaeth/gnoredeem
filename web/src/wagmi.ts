import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http } from 'wagmi'
import { gnosis } from 'wagmi/chains'
import { GNOSIS_RPC, WALLETCONNECT_PROJECT_ID } from './config'

/**
 * wagmi v2 config via RainbowKit's getDefaultConfig.
 *
 * Gnosis Chain only. We override the read transport with the configurable RPC.
 * Injected wallets work without a WalletConnect projectId; the WC/mobile QR
 * option just won't appear until VITE_WALLETCONNECT_PROJECT_ID is set.
 */
export const config = getDefaultConfig({
  appName: 'GnosisDAO Redemption',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [gnosis],
  transports: {
    [gnosis.id]: http(GNOSIS_RPC),
  },
  ssr: false,
})
