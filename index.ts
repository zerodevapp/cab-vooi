import "dotenv/config"
import {
  createKernelAccount,
  createKernelAccountClient,
} from "@zerodev/sdk"
import { ENTRYPOINT_ADDRESS_V07, bundlerActions } from "permissionless"
import { http, Hex, createPublicClient, encodeFunctionData, erc20Abi, Chain, parseUnits } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { bsc } from "viem/chains"
import { KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { CAB_V0_2_1, createKernelCABClient, supportedTokensV2_1 as supportedTokens } from "@zerodev/cab"
import { toMultiChainECDSAValidator } from "@zerodev/multi-chain-validator"

if (
  !process.env.CAB_PAYMASTER_URL ||
  !process.env.PRIVATE_KEY
) {
  throw new Error("CAB_PAYMASTER_URL or PRIVATE_KEY is not set")
}

const signer = privateKeyToAccount(process.env.PRIVATE_KEY as Hex)
const entryPoint = ENTRYPOINT_ADDRESS_V07
const kernelVersion = KERNEL_V3_1

const waitForUserInput = async () => {
  return new Promise<void>(resolve => {
    process.stdin.once('data', () => {
      resolve()
    })
  })
}

const createCABClientForChain = async (chain: Chain, bundlerRpc: string) => {
  const publicClient = createPublicClient({ chain, transport: http() })

  const ecdsaValidator = await toMultiChainECDSAValidator(publicClient, {
    signer,
    entryPoint,
    kernelVersion,
  })

  const account = await createKernelAccount(publicClient, {
    plugins: {
      sudo: ecdsaValidator,
    },
    entryPoint,
    kernelVersion,
  })

  const kernelClient = createKernelAccountClient({
    account,
    entryPoint,
    chain,
    bundlerTransport: http(bundlerRpc) 
  })

  const cabClient = createKernelCABClient(kernelClient, {
    transport: http(process.env.CAB_PAYMASTER_URL),
    entryPoint,
    cabVersion: CAB_V0_2_1
  })

  return cabClient
}

const main = async () => {
  const chain = bsc
  const bundlerRpc = process.env.BNB_BUNDLER_RPC as string

  const cabClient = await createCABClientForChain(chain, bundlerRpc)
  console.log("My account:", cabClient.account.address)

  console.log("Enabling CAB for op and arb...")
  await cabClient.enableCAB({
    tokens: [
      { name: "USDC" },
      { name: "USDT" }
    ],
  })

  while (true) {
    console.log('Checking enabled chains. Press Enter to check CAB.  Will proceed when CAB is enabled.')
    await waitForUserInput()
    const { enabledChains } = await cabClient.getEnabledChains();
    console.log("Enabled chains:", enabledChains)
    if (enabledChains.length > 3) {
      break
    }
  }

  while (true) {
    console.log('Deposit USDC on Arbitrum. Press Enter to check CAB.  Will proceed when CAB is greater than 0.')
    await waitForUserInput()
    const cabBalance = await cabClient.getCabBalance({
      address: cabClient.account.address,
      token: ['USDC', 'USDT'],
    })
    console.log("CAB balance:", cabBalance)
    if (cabBalance > 0) {
      break
    }
  }

  const repayTokens = ['USDC', 'USDT']

  // transfer 0.001 USDC to itself
  const calls = [
    {
      to: supportedTokens["USDC"][chain.id].token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [cabClient.account.address, parseUnits("0.001", 18)],
      }),
      value: BigInt(0)
    },
    {
      to: supportedTokens["USDT"][chain.id].token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [cabClient.account.address, parseUnits("0.001", 18)],
      }),
      value: BigInt(0)
    },
  ]

  const { userOperation, repayTokensInfo, sponsorTokensInfo } =
    await cabClient.prepareUserOperationRequestCAB({
      calls: calls,
      repayTokens,
    })

  console.log("userOperation:", userOperation)
  console.log("repayTokensInfo:", repayTokensInfo)
  console.log("sponsorTokensInfo:", sponsorTokensInfo)

  const userOpHash = await cabClient.sendUserOperationCAB({
    userOperation,
  })

  console.log("userOp hash:", userOpHash)

  const bundlerClient = cabClient.extend(bundlerActions(entryPoint))
  const txHash = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: 60000,
  })
  console.log("userOp completed txHash", txHash.receipt.transactionHash)

  process.exit(0)
}

main()