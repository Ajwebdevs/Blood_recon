require('dotenv').config();
const { Telegraf } = require('telegraf');
const { post } = require('axios');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const HYGRAPH_API = process.env.HYGRAPH_API_URL;
const HYGRAPH_API_TOKEN = process.env.HYGRAPH_API_TOKEN;

const requestHygraph = async (query, variables) => {
  try {
    const response = await post(
      HYGRAPH_API,
      { query, variables },
      { headers: { Authorization: `Bearer ${HYGRAPH_API_TOKEN}` } }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching from Hygraph:", error.response?.data || error);
  }
};

const userState = {};

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const name = `${ctx.from.first_name} ${ctx.from.last_name || ""}`.trim();
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

  ctx.reply(`Hello ${name}! To become a donor, please provide the following details:\n\n1. Your Phone Number`);

  userState[userId] = {
    step: 'phoneNumber',
    data: {
      telegramId: userId,
      name: name
    }
  };
});

bot.command("requestblood", async (ctx) => {
  const userId = ctx.from.id;

  ctx.reply("What is your blood group? (e.g., A+, B-, O+)");

  userState[userId] = {
    step: 'bloodGroup',
    data: {}
  };
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (!userState[userId]) return;

  const state = userState[userId];

  if (state.step === 'phoneNumber') {
    state.data.phoneNumber = text;
    state.step = 'bloodGroup';
    ctx.reply("Please provide your blood group (e.g., A+, B-, O+).");
  } else if (state.step === 'bloodGroup') {
    if (state.data.telegramId) {
      state.data.bloodGroup = text;
      state.step = 'lastDonationDate';
      ctx.reply("Please provide your last donation date (yyyy-mm-dd).");
    } else {
      state.data.bloodGroup = text;
      state.step = 'unitsNeeded';
      ctx.reply("How many units of blood do you need?");
    }
  } else if (state.step === 'lastDonationDate') {
    state.data.lastDonationDate = text;
    state.step = 'location';
    ctx.reply("Please provide your location (Locality, Panchayat, District).");
  } else if (state.step === 'unitsNeeded') {
    const unitsNeeded = Number.parseInt(text, 10);
    // biome-ignore lint/suspicious/noGlobalIsNan: <explanation>
    if (isNaN(unitsNeeded)) {
      ctx.reply("Please enter a valid number for units needed.");
      return;
    }
    state.data.unitsNeeded = unitsNeeded;
    state.step = 'location';
    ctx.reply("Enter your location (Locality, Panchayat, District):");
  } else if (state.step === 'location') {
    state.data.location = text;

    if (state.data.telegramId) {
      const donor = state.data;

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
          telegramId: String(donor.telegramId),
          name: donor.name,
          phoneNumber: donor.phoneNumber,
          bloodGroup: donor.bloodGroup,
          lastDonationDate: donor.lastDonationDate,
          location: {
            create: {
              locality: donor.location.split(",")[0].trim(),
              panchayat: donor.location.split(",")[1].trim(),
              district: donor.location.split(",")[2].trim()
            }
          }
        }
      };

      await requestHygraph(mutation, variables);
      await ctx.reply("You have successfully registered as a blood donor! Thank you for your willingness to donate.");

      delete userState[userId];
    } else {
      const { bloodGroup, unitsNeeded, location } = state.data;

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

      delete userState[userId];
    }
  }
});

export default async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling update:', err);
    res.status(500).send('Internal server error');
  }
};

const setWebhook = () => {
  const webhookUrl = `https://${process.env.VERCEL_URL}/api/bot`;
  bot.telegram.setWebhook(webhookUrl).then(() => {
    console.log('Webhook set successfully');
  }).catch((error) => {
    console.error('Error setting webhook:', error);
  });
};

setWebhook();
