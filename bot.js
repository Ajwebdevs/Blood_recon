require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const HYGRAPH_API = process.env.HYGRAPH_API_URL;
const HYGRAPH_API_TOKEN = process.env.HYGRAPH_API_TOKEN;

const requestHygraph = async (query, variables) => {
  try {
    const response = await axios.post(
      HYGRAPH_API,
      { query, variables },
      { headers: { Authorization: `Bearer ${HYGRAPH_API_TOKEN}` } }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching from Hygraph:", error.response?.data || error);
  }
};


bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const name = `${ctx.from.first_name} ${ctx.from.last_name || ""}`.trim();
  const userName = ctx.from.username || 'Not Provided';

  const query = `
  query($telegramId: String!) {
    donors(where: { telegramId: $telegramId }) {
      id
      name
    }
  }
`;

  const vars = { telegramId: String(userId) };
  const donorResponse = await requestHygraph(query, vars);


  if (donorResponse.data.donors.length > 0) {
    ctx.reply(`Welcome back, ${name}! You are already a registered donor.`);
  } else {
    ctx.reply(`Welcome ${name}!\n\nCommands:\n- /beadonor: Register as a donor\n- /requestblood: Request blood`);
  }
});

bot.command("beadonor", async (ctx) => {
  const userId = ctx.from.id;
  const name = `${ctx.from.first_name} ${ctx.from.last_name || ""}`.trim();
  const userName = ctx.from.username || 'Not Provided';

  ctx.reply(
    // biome-ignore lint/style/useTemplate: <explanation>
    `Hello ${name}! To become a donor, please provide the following details:\n\n` +
    // biome-ignore lint/style/noUnusedTemplateLiteral: <explanation>
    `1. Your Phone Number\n2. Blood Group (e.g., A+, B-, O+)\n3. Last Donation Date (yyyy-mm-dd)\n4. Location: Locality, Panchayat, District`
  );

  // Set up a temporary state to capture user inputs
  const donorInfo = {
    telegramId: userId,
    name: name,
    phoneNumber: null,
    bloodGroup: null,
    lastDonationDate: null,
    location: null
  };

  bot.on('text', async (msgCtx) => {
    const responseText = msgCtx.message.text;

    if (!donorInfo.phoneNumber) {
      donorInfo.phoneNumber = responseText;
      await msgCtx.reply("Please provide your blood group (e.g., A+, B-, O+).");
    } else if (!donorInfo.bloodGroup) {
      donorInfo.bloodGroup = responseText;
      await msgCtx.reply("Please provide your last donation date (yyyy-mm-dd).");
    } else if (!donorInfo.lastDonationDate) {
      donorInfo.lastDonationDate = responseText;
      await msgCtx.reply("Please provide your location (Locality, Panchayat, District).");
    } else if (!donorInfo.location) {
      donorInfo.location = responseText;

      const mutation = `
        mutation($data: DonorCreateInput!) {
          createDonor(data: $data) {
            id
            name
          }
        }
      `;

      const variables = {
        data: {
          telegramId: String(donorInfo.telegramId),
          name: donorInfo.name,
          phoneNumber: donorInfo.phoneNumber,
          bloodGroup: donorInfo.bloodGroup,
          lastDonationDate: donorInfo.lastDonationDate,
          location: {
            create: {
              locality: donorInfo.location.split(",")[0],
              panchayat: donorInfo.location.split(",")[1],
              district: donorInfo.location.split(",")[2]
            }
          }
        }
      };


      await requestHygraph(mutation, variables);
      await msgCtx.reply("You have successfully registered as a blood donor! Thank you for your willingness to donate.");
    }
  });
});


bot.command("requestblood", async (ctx) => {
  ctx.reply("What is your blood group? (e.g., A+, B-, O+)");

  bot.on("text", async (msgCtx) => {
    const bloodGroup = msgCtx.message.text;
    ctx.reply("How many units of blood do you need?");

    bot.on("text", async (unitCtx) => {
      const unitsNeeded = Number.parseInt(unitCtx.message.text, 10);
      ctx.reply("Enter your location (Locality, Panchayat, District):");

      bot.on("text", async (locCtx) => {
        const location = locCtx.message.text;
        const requestData = { bloodGroup, unitsNeeded, location };

        //Eligible donors query
        const query = `
          query($bloodGroup: String!, $location: String!) {
            donors(where: { bloodGroup: $bloodGroup, location_contains: $location }) {
              name
              phoneNumber
              location {
                locality
                panchayat
                district
              }
            }
          }
        `;

        const variables = { bloodGroup, location };
        const donorsResponse = await requestHygraph(query, variables);

        if (donorsResponse.data.donors.length > 0) {
          const donorsList = donorsResponse.data.donors.map(donor => `
            Name: ${donor.name}
            Contact: ${donor.phoneNumber}
            Location: ${donor.location.locality}, ${donor.location.panchayat}, ${donor.location.district}
          `).join("\n\n");

          ctx.reply(`We found eligible donors for your request:\n\n${donorsList}`);
        } else {
          ctx.reply("Sorry, no donors are available at the moment.");
        }
      });
    });
  });
});

bot.launch();

