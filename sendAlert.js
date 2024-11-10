const axios = require("axios");

// // binancetest
// const data = {
//   exchange: "binancetest",
//   ticker: "OPUSDT",
//   side: "buy",
//   amount: "10", // minimum is $5
//   alertName: "crossing up",
//   password: "testtest",
// };

// // binance
// const data = {
//   exchange: "binance",
//   ticker: "FDUSDUSDT",
//   side: "buy",
//   amount: "6", // minimum is $5
//   alertName: "crossing up",
//   password: "testtest",
// };

// // coinbase
// const data = {
//   exchange: "coinbase",
//   ticker: "USDTUSD",
//   side: "sell",
//   amount: "2", // minimum is $1
//   alertName: "crossing up",
//   password: "testtest",
// };

// matcha
const data = {
  exchange: "matcha",
  side: "sell",
  ticker: "USDTUSDC",
  network: "Polygon",
  amount: "0.1",
  price: "1",
  slippage1: "0.8", // if (matcha.quotePrice - tv.price) / tv.price > slippage1, then trade will not execute. IN PERCENTAGE, so "1" = 1%.
  slippage2: "0.005", // if (matcha.gauranteedPrice - matcha.quotePrice) / matcha.quotePrice > slippage 2, then trade will not execute.  IN PERCENTAGE, so "1" = 1%.
  alertName: "crossing up",
  password: "testtest",
};

// webhook url
// const url = "http://localhost:8080";
const url = "https://d1da-36-230-171-13.ngrok-free.app"; // example ngrok url
// const url = "https://trading-view-adapter-a04372cf2e4g.herokuapp.com/"; // example heroku url
// const url = "https://dev-b3gfgsdfs3a-de.a.run.app"; // example google cloud run url

(async () => {
  axios
    .post(url, data)
    .then((res) => {
      return;
    })
    .catch((e) => {
      console.log(e.message);
    });
})();
