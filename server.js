const express = require("express"); // defacto server framework for NodeJS
const cors = require("cors"); // allows other sites to visit our endpoints
require("dotenv").config(); // for process.env to work
const axios = require("axios"); // make API requests (for telegram)
const ccxt = require("ccxt"); // library of unified CEX APIs
const { google } = require("googleapis"); // library to connect to google services
// web3
const { ethers } = require("ethers"); // library of Ethereum JSON-RPC API endpoints
const { matchaTargetAddresses, matchaEndpoints, rpcUrls } = require("./constants/constants"); // needed constants for swapping on matcha
const ERC20ABI = require("./ERC20ABI.json"); // ABI of ERC20 contract
const qs = require("qs"); // to combine params into a query string

const app = express();

app.listen(process.env.PORT, () => {
  console.log(`listening on port ${process.env.PORT}`); // Heroku overrides process.env.PORT with own value, so it won't be 8080
});

app.use(express.json()); // middleware to recognize incoming req.body as a JSON Object
app.use(express.urlencoded({ extended: true })); // middleware to regonize incoming req.body as html or strings/arrays
app.use(cors()); // allows other sites to visit our endpoints

app.post("/", async (req, res) => {
  const data = req.body; // "data" = Trading View Alert JSON message

  // exits App if wrong password
  if (data.password != process.env.TV_PASSWORD) {
    console.log("wrong password");
    return;
  }

  var ERROR = false; // initialize global ERROR variable. Search this document to see how "ERROR" is used.

  /************ EXECUTE TRADE ************/
  try {
    // BINANCE TESTNET
    if (data.exchange === "binancetest") {
      const binance = new ccxt.binance({
        enableRateLimit: true,
        apiKey: process.env.BINANCE_TESTNET_API,
        secret: process.env.BINANCE_TESTNET_SECRET,
      });
      binance.setSandboxMode(true); // set to testnet

      var ticker = data.ticker; // use "ticker" instead of "data.ticker"

      var order = await binance.createMarketOrder(ticker, data.side, data.amount); // execute market order and log it
      console.log(`${data.side} ${order.filled} ${data.ticker} at ${order.average} (fee: ${order.fees[0].cost} USD)`); // log message

      var tokenBalance = await binance.fetchBalance().then((balances) => balances.info.balances.find((i) => i.asset === data.ticker.split("USDT")[0]).free); // get balance of the base token
      var uBalance = await binance.fetchBalance().then((balances) => balances.info.balances.find((i) => i.asset === "USDT").free); // get balance of USDT (u is alias for usdt or usd)
    }

    // BINANCE
    if (data.exchange === "binance") {
      const binance = new ccxt.binance({
        enableRateLimit: true,
        apiKey: process.env.BINANCE_API,
        secret: process.env.BINANCE_SECRET,
      });

      var ticker = data.ticker; // use "ticker" instead of "data.ticker"

      var order = await binance.createMarketOrder(ticker, data.side, data.amount); // execute market order and log it
      console.log(`${data.side} ${order.filled} ${ticker} at ${order.average} (fee: ${order.fees[0].cost} USD)`); // log message

      var tokenBalance = await binance.fetchBalance().then((balances) => balances.info.balances.find((i) => i.asset === ticker.split("USDT")[0]).free); // get balance of the base token
      var uBalance = await binance.fetchBalance().then((balances) => balances.info.balances.find((i) => i.asset === "USDT").free); // get balance of USDT (u is alias for usdt or usd)
    }

    // COINBASE
    if (data.exchange === "coinbase") {
      const coinbase = new ccxt.coinbase({
        enableRateLimit: true,
        apiKey: process.env.COINBASE_KEY,
        secret: process.env.COINBASE_SECRET,
        options: { createMarketBuyOrderRequiresPrice: false }, // needed specifically for Coinbase
      });

      var ticker = data.ticker.slice(0, -3) + "/USD"; // reformat ticker to <token>/USD

      const orderReceipt = await coinbase.createMarketOrder(ticker, data.side, data.amount); // execute market order
      var order = await coinbase.fetchOrder(orderReceipt.id); // coinbase different to binance, need this extra step
      console.log(`${data.side} ${order.filled} ${ticker} at ${order.average} (fee: ${order.fees[0].cost} USD)`); // log message

      var tokenBalance = await coinbase.fetchBalance().then((balances) => balances.total[ticker]); // get balance of the base token
      var uBalance = await coinbase.fetchBalance().then((balances) => balances.total["USD"]); // get balance of USDT (u is alias for usdt or usd)
    }

    // MACTHA AGGREGATOR
    if (data.exchange === "matcha") {
      // create wallet instance
      const provider = new ethers.JsonRpcProvider(rpcUrls[data.network]);
      const signer = new ethers.Wallet(process.env.MY_PRIVATE_KEY, provider);

      // create token contract instances
      const sellTokenContract = new ethers.Contract(data.sellToken, ERC20ABI, signer);
      const buyTokenContract = new ethers.Contract(data.buyToken, ERC20ABI, signer);

      // fetches the "decimals" of the tokens using the Ethereum API
      const sellTokenDecimals = Number(await sellTokenContract.decimals());
      const buyTokenDecimals = Number(await buyTokenContract.decimals());

      // define Matcha API params, see https://0x.org/docs/0x-swap-api/api-references/get-swap-v1-quote
      const params = {
        sellToken: data.sellToken,
        buyToken: data.buyToken,
        sellAmount: ethers.parseUnits(data.amount, sellTokenDecimals),
        takerAddress: process.env.MY_ADDRESS, // address that will make the trade
        slippagePercentage: data.slippage2, // in decimals
      };
      const headers = { "0x-api-key": process.env.ZEROEX_KEY }; // the "header" is sent on every request to the Matcha API

      // this function checks of you have sufficieint approval of the sellToken
      const checkApprove = async () => {
        const approvedAmount = ethers.formatUnits(await sellTokenContract.allowance(signer.address, matchaTargetAddresses[data.network]), sellTokenDecimals);
        if (approvedAmount >= data.amount) {
          console.log(`Sufficient tokens approved (approvedAmount = ${approvedAmount})`);
          return true;
        } else {
          console.log("Error: Not enough tokens approved");
          return false;
        }
      };

      //  this function sets approval of the token to a very big number
      const approve = async () => {
        console.log("Approving sellToken...");
        const txResponse = await sellTokenContract.approve(matchaTargetAddresses[data.network], BigInt("1000000000000000000000000000000"));
        const txReceipt = await txResponse.wait();
        console.log("Approve hash:", txReceipt.hash);
      };

      // this function gets a "soft" price. If it does not exceed slippage1, it then proceeeds to get a "firm price", and executes the swap
      const getQuoteAndSwap = async () => {
        // gets "soft" price from Matcha API
        const priceAPIResponse = await fetch(`${endpoints[data.network]}swap/v1/price?${qs.stringify(params)}`, { headers });
        const priceAPIObject = await priceAPIResponse.json();

        // If "soft" price (compared to "firm price") does not exceed slippage1, then get the "firm" price.
        const priceDiff = (priceAPIObject.price - data.price) / data.price;
        if (priceDiff <= data.slippage1) {
          // Gets the "firm" and "gauranteed" price from the Matcha API. If the "firm price" does not exceed " slippage2 (which is in "params"), then the txn will not go through
          const quoteAPIResponse = await fetch(`${matchaEndpoints[data.network]}swap/v1/quote?${qs.stringify(params)}`, { headers });
          const quoteAPIObject = await quoteAPIResponse.json();

          // send transaction
          const txResponse = await signer.sendTransaction({
            gasLimit: quoteAPIObject.gas,
            gasPrice: quoteAPIObject.gasPrice,
            to: quoteAPIObject.to,
            data: quoteAPIObject.data,
            value: quoteAPIObject.value,
            chainId: quoteAPIObject.chainId,
          });
          const hash = (await txResponse.wait()).hash; // gets the txn hash

          // convert sellAmount to human-readable format (should be equal to data.amount)
          const sellAmount = ethers.formatUnits(quoteAPIObject.sellAmount, sellTokenDecimals);

          // get buyToken amount from hash
          const interface = new ethers.Interface(ERC20ABI);
          const txReceipt = await provider.getTransactionReceipt(hash);
          let amountReceivedBigInt = BigInt(0);
          for (const log of txReceipt.logs) {
            if (log.address == data.buyToken) {
              let parsedLog = interface.parseLog(log); // parsedLog.args[1] = toAddress, parsedLog.args[2] = amount
              if (parsedLog.args[1] == process.env.MY_ADDRESS) {
                amountReceivedBigInt = amountReceivedBigInt + parsedLog.args[2];
              }
            }
          }
          const amountReceived = ethers.formatUnits(amountReceivedBigInt, sellTokenDecimals);

          const buyTokenBalance = ethers.formatUnits(await buyTokenContract.balanceOf(signer.address), buyTokenDecimals); // get buyToken balance

          const sellTokenBalance = ethers.formatUnits(await sellTokenContract.balanceOf(signer.address), buyTokenDecimals); // get sellToken balance

          const fee = ethers.formatUnits(quoteAPIObject.fees.zeroExFee.feeAmount, sellTokenDecimals); // get fee, fee is in buyToken

          // return all the above info
          return { order: { average: amountReceived / sellAmount, filled: amountReceived, cost: sellAmount }, buyTokenBalance, sellTokenBalance };
        } else {
          console.log(
            `Trade did not execute.
              Price difference (${(priceDiff * 100).toFixed(2)}%) exceeded slippage1 (${(data.slippage1 * 100).toFixed(2)}%)
              Trading View Alert Price: ${data.price}
              Matcha Price: ${priceAPIObject.price}`
          );
        }
      };

      // approve and swap
      const isApproved = await checkApprove();
      if (isApproved) {
        var { order, buyTokenBalance, sellTokenBalance } = await getQuoteAndSwap();
      } else {
        await approve();
        var { order, buyTokenBalance, sellTokenBalance } = await getQuoteAndSwap();
      }
    }
  } catch (e) {
    ERROR = e.message;
    console.log("transaction failed", ERROR);
  }

  /************ LOG TO GOOGLE SHEETS ************/
  try {
    const auth = new google.auth.GoogleAuth(
      process.env.DYNO // this is true in Heroku
        ? {
            scopes: "https://www.googleapis.com/auth/spreadsheets",
            keyFile: "googlekey.json",
          }
        : { scopes: "https://www.googleapis.com/auth/spreadsheets" } // if google cloude  does not need keyFile
    );
    const authClientObject = await auth.getClient(); // create the authenticated client
    const googleSheetsInstance = google.sheets({ version: "v4", auth: authClientObject }); // create an instance using the client

    // define requests, depending on cex or dex. "requests" is an array of actions. We have 2 actions: 1) insert a blank row and 2) write to the cells
    if (data.exchange === "matcha") {
      var requests = [
        {
          insertRange: {
            range: {
              sheetId: 0,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 20,
            },
            shiftDimension: "ROWS",
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 0,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 10,
            },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: new Date().toLocaleString() } },
                  { userEnteredValue: { stringValue: data.ticker } },
                  { userEnteredValue: { stringValue: data.side } },
                  { userEnteredValue: { numberValue: ERROR ? data.amount : order.filled } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : order.average } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : order.cost } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : buyTokenBalance } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : sellTokenBalance } },
                  { userEnteredValue: { stringValue: data.alertName } },
                  { userEnteredValue: { stringValue: ERROR ? "FAILED: " + ERROR : "" } },
                ],
              },
            ],
            fields: "userEnteredValue",
          },
        },
      ];
    } else {
      var requests = [
        {
          insertRange: {
            range: {
              sheetId: 0,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 20,
            },
            shiftDimension: "ROWS",
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 0,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 10,
            },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: new Date().toLocaleString() } },
                  { userEnteredValue: { stringValue: ticker } },
                  { userEnteredValue: { stringValue: data.side } },
                  { userEnteredValue: { numberValue: ERROR ? data.amount : order.filled } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : order.average } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : order.cost } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : tokenBalance } },
                  { userEnteredValue: { numberValue: ERROR ? 0 : uBalance } },
                  { userEnteredValue: { stringValue: data.alertName } },
                  { userEnteredValue: { stringValue: ERROR ? "FAILED: " + ERROR : "" } },
                ],
              },
            ],
            fields: "userEnteredValue",
          },
        },
      ];
    }

    // write to google sheet
    await googleSheetsInstance.spreadsheets.batchUpdate({
      auth,
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      resource: {
        requests: requests,
      },
    });
  } catch (e) {
    console.log("failed logging ot google sheets", e.message);
  }

  /************ SEND TELEGRAM NOTIFICATION ************/
  try {
    // define text
    if (data.exchange === "matcha") {
      if (ERROR) {
        var text = `FAILED TRANSACTION \nReason: ${ERROR} \nTrading View alert: ${data.exchange} ${data.side} ${data.amount} ${ticker} ${data.alertName}`;
      } else {
        var text = `Transaction completed on ${data.exchange}. ${order.filled} ${ticker} ${data.side} at ${order.average} \nTotal cost: ${order.cost}) \nBuyToken Balance: ${buyTokenBalance} \nSellToken Balance: ${sellTokenBalance}`;
      }
    } else {
      if (ERROR) {
        var text = `FAILED TRANSACTION \nReason: ${ERROR} \nTrading View alert: ${data.exchange} ${data.side} ${data.amount} ${ticker} ${data.alertName}`;
      } else {
        var text = `Transaction completed on ${data.exchange}. ${order.filled} ${ticker} ${data.side} at ${order.average} \nTotal cost: ${order.cost}) \nToken balance: ${tokenBalance} \nUSDT/USD balance: ${uBalance}`;
      }
    }

    // send text
    axios.post(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.TG_CHAT_ID,
      text: text,
    });
  } catch (e) {
    console.log("failed sending telegram message", e.message);
  }
});
