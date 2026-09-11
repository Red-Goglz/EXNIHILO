export const preMarketAbi = [
    {
      "inputs": [
        {
          "components": [
            {
              "internalType": "address",
              "name": "token",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "quote",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "usdc",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "factory",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "creator",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "lpOwner",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "integrator",
              "type": "address"
            },
            {
              "internalType": "uint8",
              "name": "quoteDecimals",
              "type": "uint8"
            },
            {
              "internalType": "uint256",
              "name": "startPrice",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "decayBpsPerMinute",
              "type": "uint256"
            }
          ],
          "internalType": "struct PreMarket.Config",
          "name": "c",
          "type": "tuple"
        },
        {
          "internalType": "uint256",
          "name": "tokenAmount",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "quoteAmount",
          "type": "uint256"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "constructor"
    },
    {
      "inputs": [],
      "name": "AlreadyLaunched",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "BuyoutNotPriceable",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "CostExceedsMax",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "FeeOnTransferNotSupported",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "InvalidDecayRate",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "InvalidPriceRange",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "NoAuction",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "NotDirectLaunch",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "NotFunded",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "OnlySeeder",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "QuoteBelowMin",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "ReentrancyGuardReentrantCall",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "token",
          "type": "address"
        }
      ],
      "name": "SafeERC20FailedOperation",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "SeedBelowMinimum",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "SlippageExceeded",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "TokenIsQuote",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "TokenIsUsdc",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "UsdcMismatch",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "ZeroAddress",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "ZeroAmount",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "ZeroOutput",
      "type": "error"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "buyer",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "usdcPaid",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "quoteReceived",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "price",
          "type": "uint256"
        }
      ],
      "name": "BoughtOut",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "pool",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "lpVault",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "lpNftId",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "tokenAmount",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "usdcAmount",
          "type": "uint256"
        }
      ],
      "name": "Launched",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "tokenAmount",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "quoteAmount",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "startPrice",
          "type": "uint256"
        }
      ],
      "name": "Seeded",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "sender",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "to",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "bool",
          "name": "tokenToQuote",
          "type": "bool"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountIn",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountOut",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "tokenReserve",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "quoteReserve",
          "type": "uint256"
        }
      ],
      "name": "Swapped",
      "type": "event"
    },
    {
      "inputs": [
        {
          "internalType": "uint256",
          "name": "maxUsdc",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "minQuoteOut",
          "type": "uint256"
        }
      ],
      "name": "buyout",
      "outputs": [
        {
          "internalType": "address",
          "name": "pool",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "lpNftId",
          "type": "uint256"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "buyoutCost",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "usdcCost",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "quoteOut",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "confirmFunded",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "creator",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "currentPrice",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "decayBpsPerMinute",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "directLaunch",
      "outputs": [
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "factory",
      "outputs": [
        {
          "internalType": "contract IEXNIHILOMarketFactory",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "funded",
      "outputs": [
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "uint256",
          "name": "amountIn",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "reserveIn",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "reserveOut",
          "type": "uint256"
        }
      ],
      "name": "getAmountOut",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "pure",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "integrator",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "launchDirect",
      "outputs": [
        {
          "internalType": "address",
          "name": "pool",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "lpNftId",
          "type": "uint256"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "launchUsdc",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "launched",
      "outputs": [
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "launchedPool",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "lpOwner",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "lpVault",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "quote",
      "outputs": [
        {
          "internalType": "contract IERC20",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "quoteReserve",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "quoteUnit",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "seeder",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "startPrice",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "startTime",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "uint256",
          "name": "amountIn",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "minAmountOut",
          "type": "uint256"
        },
        {
          "internalType": "bool",
          "name": "tokenToQuote",
          "type": "bool"
        },
        {
          "internalType": "address",
          "name": "to",
          "type": "address"
        }
      ],
      "name": "swap",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "amountOut",
          "type": "uint256"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "swapFeeBps",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "token",
      "outputs": [
        {
          "internalType": "contract IERC20",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "tokenReserve",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "usdc",
      "outputs": [
        {
          "internalType": "contract IERC20",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ] as const;
