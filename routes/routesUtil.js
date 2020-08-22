const db = require("../models");
// Load the SDK for JavaScript
const AWS = require("aws-sdk");
const { Op } = require("sequelize");
const fs = require("fs");
const axios = require("axios");

require("dotenv").config();
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const bucketName = "timeless-recipes.appspot.com";

const imageUrlFixed =
  "https://s3-ap-southeast-2.amazonaws.com/timeless-recipes.appspot.com/";
const defaultUrl = "/images/e-logo-placeholder.png";

const generateImageUrlForClient = savedUrl =>
  savedUrl ? `${imageUrlFixed}${savedUrl}` : defaultUrl;

const generateImageUrlToSave = async request => {
  if (request.file) {
    const uploadParams = { Bucket: bucketName, Key: "", Body: "" };
    const fileStream = fs.createReadStream(
      `./temp/uploads/${request.file.filename}`
    );
    fileStream.on("error", error => {
      console.log("File Error", error);
      return;
    });
    uploadParams.Body = fileStream;
    uploadParams.Key = request.file.filename;
    // call S3 to retrieve upload file to specified bucket
    s3.upload(uploadParams, (error, data) => {
      if (error) {
        console.log("Error", error);
      }
      if (data) {
        console.log("Upload Success", data.Location);
        fs.unlink(`./temp/uploads/${request.file.filename}`, error =>
          error
            ? console.log(
                `error ocurred while deleting recipe image from temp folder. detailed error is following: ${error}`
              )
            : console.log(`${request.file.filename} is deleted from temp`)
        );
      }
    });
    return request.file.filename;
  }
  return null;
};
/**
 * creates a recipe entry in recipes table
 * and returns same
 * @param {request received from client} request
 */
const createRecipe = async request => {
  const recipeImageUrl = await generateImageUrlToSave(request);
  const recipeObject = {
    title: request.body.title,
    instructions: request.body.instructions,
    servings: request.body.servings,
    preparationTime: request.body.preparationTime,
    notes: request.body.notes,
    imageUrl: recipeImageUrl,
    UserId: request.user.id
  };
  try {
    const parsedIngredients = await parseIngredients({
      ingredientList: request.body.ingredients,
      servings: request.body.servings
    });
    if (parsedIngredients) {
      const recipe = await db.Recipe.create(recipeObject);
      const persistedIngredients = await persistAndFetchIngredients(
        parsedIngredients
      );
      if (persistedIngredients) {
        const status = await persistRecipeIngredients(
          parsedIngredients,
          persistedIngredients,
          recipe.id
        );
        return status ? 201 : 500;
      }
    }
    console.log(
      "Failed to create recipe completely as failed to parse or persist ingredients"
    );
    return 500;
  } catch (error) {
    console.log(
      `Error ocurred while creating recipe. detailed error is following: ${error.stack}`
    );
    return 500;
  }
};

/**
 * it checks what new ingredient are provided by user
 * then only persist those ingredients in ingredients table
 * @param {request received from client} request
 */
const persistAndFetchIngredients = async parsedIngredients => {
  let persistedIngredients;
  try {
    persistedIngredients = await db.Ingredient.findAll();
  } catch (error) {
    console.log(
      `Failed to retreive saved ingredients due to following error: ${error.stack}`
    );
    return;
  }
  let ingredientToSave;
  if (persistedIngredients.length) {
    const currentIngredients = persistedIngredients.map(element => {
      return element.title.toLowerCase();
    });
    ingredientToSave = parsedIngredients
      .filter(
        element => currentIngredients.indexOf(element.title.toLowerCase()) < 0
      )
      .map(element => {
        return {
          title: element.title.toLowerCase()
        };
      });
  } else {
    ingredientToSave = parsedIngredients.map(element => {
      return {
        title: element.title.toLowerCase()
      };
    });
  }
  try {
    const newlyCreatedIngredient = await db.Ingredient.bulkCreate(
      ingredientToSave
    );
    persistedIngredients = persistedIngredients.concat(newlyCreatedIngredient);
  } catch (error) {
    console.log(
      `failed to persist new ingredients due to following error: ${error.stack}`
    );
    return;
  }
  return persistedIngredients;
};

/**
 * it persists recipe and ingredient relations
 * in recipeIngredients table i.e. what quantity
 * of what ingredient is needed for which recipe,
 * and returns true if it was done successfully otherwise false.
 * @param {parsed ingredients for current recipe} parsedIngredients
 * @param {all ingredients currently saved} persistedIngredients
 * @param {id of recipe being saved currently} recipeId
 */
const persistRecipeIngredients = async (
  parsedIngredients,
  persistedIngredients,
  recipeId
) => {
  const recipeIngredientsToSave = parsedIngredients.map(element => {
    return {
      ingredientQuantity: element.quantity,
      ingredQuantUnit: element.units,
      RecipeId: recipeId,
      IngredientId: persistedIngredients
        .filter(ingredient => {
          return ingredient.title.toLowerCase() === element.title.toLowerCase();
        })
        .map(ingredient => ingredient.id)[0]
    };
  });
  try {
    await db.RecipeIngredient.bulkCreate(recipeIngredientsToSave);
    return true;
  } catch (error) {
    console.log(
      `failed to persist recipe ingredients due to following error: ${error.stack}`
    );
    return false;
  }
};
/**
 * it fetches all recipes which belongs to current user
 * and returns an array of recipe title, id and preparationTime
 * for each user recipe
 * @param {request from client} request
 */
const getAllRecipesForCurrentUser = async request => {
  const userId = request.user.id;
  try {
    const recipes = await db.Recipe.findAll({
      where: {
        UserId: userId
      },
      attributes: ["id", "title", "preparationTime", "imageUrl"]
    });
    return mapRecipeHighLevelDetails(recipes, userId);
  } catch (error) {
    console.log(
      `Failed to retrieve recipes due to following error: ${error.stack}`
    );
  }
};

/**
 * fetches recipe details for a given recipe id
 * and returns an object having all recipe details
 * @param {request sent by client} request
 */
const getRecipeDetails = async request => {
  const recipeId = request.params.id;
  try {
    const recipe = await db.Recipe.findOne({
      where: {
        id: recipeId
      }
    });
    if (!recipe) {
      return;
    }
    let ingredientDetails = [];
    const recipeIngredients = await recipe.getRecipeIngredients();
    if (recipeIngredients && recipeIngredients.length) {
      const ingredientIds = recipeIngredients.map(
        element => element.IngredientId
      );
      const ingredients = await db.Ingredient.findAll({
        where: {
          id: {
            [Op.or]: ingredientIds
          }
        }
      });
      ingredientDetails = recipeIngredients.map(element => {
        const ingredientName = ingredients
          .filter(ingredient => ingredient.id === element.IngredientId)
          .map(ingredient => ingredient.title);
        return {
          title: ingredientName[0],
          quantity: element.ingredientQuantity,
          unit: element.ingredQuantUnit
        };
      });
    }
    const recipeDetails = {
      title: recipe.title,
      instructions: recipe.instructions,
      preparationTime: recipe.preparationTime,
      servings: recipe.servings,
      notes: recipe.notes,
      imageUrl: generateImageUrlForClient(recipe.imageUrl),
      ingredients: ingredientDetails,
      id: request.params.id,
      userRecipe: recipe.UserId === request.user.id
    };
    return recipeDetails;
  } catch (error) {
    console.log(
      `Failed to retrieve recipe details due to following error: ${error.stack}`
    );
  }
};

/**
 * searches recipe by searching searchText in
 * recipe title as well as ingredient title
 * and returns all recipes where either searchhText
 * present in title or recipe is based on one of such inredient
 * also filters searched recipe based on if user is looking for
 * his/her own recipes or all other users recipes as well.
 * @param {request sent by client} request
 */
const getRecipesByTextSearch = async request => {
  try {
    const userId = request.user.id;
    const searchText = request.query.searchText.toLowerCase();
    const relevantIngredientIds = await db.Ingredient.findAll({
      where: {
        title: {
          [Op.like]: `%${searchText}%`
        }
      },
      attributes: ["id"]
    });
    let ingredientBasedRecipeIds = [];
    if (relevantIngredientIds && relevantIngredientIds.length) {
      const ingredientIds = relevantIngredientIds.map(element => element.id);
      ingredientBasedRecipeIds = await db.RecipeIngredient.findAll({
        where: {
          IngredientId: {
            [Op.or]: ingredientIds
          }
        },
        attributes: ["RecipeId"]
      });
    }
    let searchedRecipes = await db.Recipe.findAll({
      where: {
        [Op.or]: [
          {
            title: {
              [Op.like]: `%${searchText}%`
            }
          },
          {
            id: {
              [Op.or]: ingredientBasedRecipeIds.map(element => element.RecipeId)
            }
          }
        ]
      },
      attributes: ["id", "title", "preparationTime", "imageUrl", "UserId"]
    });
    if (request.query.onlyUserRecipes === "true") {
      searchedRecipes = searchedRecipes.filter(
        recipe => recipe.UserId === userId
      );
    }
    return mapRecipeHighLevelDetails(searchedRecipes, userId);
  } catch (error) {
    console.log(
      `error ocurred while searching for recipes based on search criteria: ${JSON.stringify(
        request.query
      )} detailed error is following: ${error.stack}`
    );
  }
};

/**
 * maps list of recipe to desired data for client
 * @param {array of recipe to map} recipes
 * @param {current userId} userId
 */
function mapRecipeHighLevelDetails(recipes, userId) {
  return recipes.map(recipe => {
    return {
      title: recipe.title,
      preparationTime: recipe.preparationTime,
      id: recipe.id,
      imageUrl: generateImageUrlForClient(recipe.imageUrl),
      userRecipe: recipe.UserId ? recipe.UserId === userId : true
    };
  });
}

const getAllRecipeIds = async () => {
  try {
    const findRecipesWithPictures = await db.Recipe.findAll({
      where: {
        imageUrl: {
          [Op.not]: null
        }
      },
      attributes: ["id", "title", "preparationTime", "imageUrl"],
      limit: 20
    });
    const recipeDetails = findRecipesWithPictures.map(recipe => {
      return {
        id: recipe.dataValues.id,
        title: recipe.dataValues.title,
        preparationTime: recipe.dataValues.preparationTime,
        imageUrl: generateImageUrlForClient(recipe.dataValues.imageUrl)
      };
    });
    return recipeDetails;
  } catch (error) {
    console.log(error);
  }
};

/**
 * deletes input recipe id from database
 * @param {request sent by client} request
 */
const deleteRecipe = async request => {
  try {
    const recipeId = request.params.id;
    if (recipeId) {
      await db.RecipeIngredient.destroy({
        where: {
          RecipeId: recipeId
        }
      });
      await deleteimage(recipeId);
      await db.Recipe.destroy({
        where: {
          id: recipeId
        }
      });
      return 204;
    }
    return 400;
  } catch (error) {
    console.log(
      `Error ocurred while deleting recipeId: ${recipeId}. Detailed error is following: ${error.stack}`
    );
    return 500;
  }
};

/**
 * updates Recipe details as per the data sent by client
 * and return http status code accordingly.
 * if ingredient was updated then we are removing old ingredients
 * recipe relations and creating new ones, otherwise we are updating
 * existing data.
 * also if new image uploaded then old image will be deleted
 * @param {request sent by client} request
 */
const updateRecipe = async request => {
  const updateRecipe = {};
  if (request.file) {
    updateRecipe.imageUrl = await generateImageUrlToSave(request);
    await deleteimage(request.params.id);
  }
  if (request.body) {
    Object.keys(request.body).forEach(key => {
      const value = request.body[key];
      if (key && value && value !== "undefined") {
        switch (key) {
          case "notes":
            updateRecipe.notes = value;
            break;
          case "title":
            updateRecipe.title = value;
            break;
          case "instructions":
            updateRecipe.instructions = value;
            break;
          case "preparationTime":
            updateRecipe.preparationTime = value;
            break;
          case "servings":
            updateRecipe.servings = value;
        }
      }
    });
  }
  if (Object.keys(updateRecipe)) {
    try {
      await db.Recipe.update(updateRecipe, {
        where: {
          id: request.params.id
        }
      });
    } catch (error) {
      console.log(
        `error ocurred while updating recipe table for recipe id ${request.params.id}. Detailed error is: ${error.stack}`
      );
      return 500;
    }
  }
  if (request.body.ingredients && request.body.ingredients !== "undefined") {
    const parsedIngredients = await parseIngredients({
      ingredientList: request.body.ingredients,
      servings: request.body.servings
    });
    if (parsedIngredients) {
      const persistedIngredients = await persistAndFetchIngredients(
        parsedIngredients
      );
      if (persistedIngredients) {
        // first clean up existing relations
        try {
          await db.RecipeIngredient.destroy({
            where: {
              RecipeId: request.params.id
            }
          });
        } catch (error) {
          console.log(
            `error ocurred while clearing data from recipeIngredients table for recipe id: ${request.params.id}. Detailed error : ${error.stack}`
          );
          return 500;
        }
        // create new relations
        const status = await persistRecipeIngredients(
          parsedIngredients,
          persistedIngredients,
          request.params.id
        );
        return status ? 204 : 500;
      }
    }
    console.log("Failed To Parse Ingredients");
    return 500;
  }
  return 204;
};

/**
 * parses ingredients and returns parse ingredients as array using
 * spoonacular API
 * @param {request data relevant to call spoonacular API} spoonacularRequestData
 */
async function parseIngredients(spoonacularRequestData) {
  const apiKeyParseIngredients = process.env.API_KEY_PARSE_INGREDIENTS;
  try {
    const response = await axios({
      method: "post",
      url: `https://api.spoonacular.com/recipes/parseIngredients?apiKey=${apiKeyParseIngredients}`,
      params: spoonacularRequestData
    });
    const parsedIngredients = response.data.map(item => {
      return {
        title: item.originalName,
        quantity: item.amount,
        units: item.unitShort
      };
    });
    return parsedIngredients;
  } catch (error) {
    console.log(
      `Failed to process ingredients data. Detailed error is : ${error}`
    );
    return;
  }
}

/**
 * deleltesinput recipe id image from S3 storage.
 * @param {recipe id whose current image need to be deleted} recipeId
 */
async function deleteimage(recipeId) {
  try {
    const recipe = await db.Recipe.findOne({
      where: {
        id: recipeId
      },
      attributes: ["imageUrl", "title"]
    });
    const imageFileName = recipe.imageUrl;
    if (imageFileName) {
      const params = { Bucket: bucketName, Key: imageFileName };
      s3.deleteObject(params, error => {
        if (error) {
          console.log(error, error.stack);
        } else {
          console.log(
            `${imageFileName} removed successfully from ${bucketName}`
          );
        }
      });
    }
  } catch (error) {
    console.log(
      `error ocurred while deleting image. detailed error: ${error.stack}`
    );
  }
}

module.exports = {
  createRecipe,
  persistAndFetchIngredients,
  persistRecipeIngredients,
  getAllRecipesForCurrentUser,
  getRecipeDetails,
  getRecipesByTextSearch,
  deleteRecipe,
  getAllRecipeIds,
  updateRecipe
};
