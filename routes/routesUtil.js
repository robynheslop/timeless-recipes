const db = require("../models");
/**
 * creates a recipe entry in recipes table
 * and returns same
 * @param {request received from client} request
 */
const createRecipe = async request => {
  const recipeObject = {
    title: request.body.title,
    instructions: request.body.instructions,
    servings: request.body.servings,
    preparationTime: request.body.preparationTime,
    notes: request.body.notes,
    UserId: request.user.id
  };
  try {
    const recipe = await db.Recipe.create(recipeObject);
    return recipe;
  } catch (error) {
    console.log(
      `Error ocurred while creating recipe. detailed error is following: ${error}`
    );
  }
};

/**
 * it checks what new ingredient are provided by user
 * then only persist those ingredients in ingredients table
 * @param {request received from client} request
 */
const persistAndFetchIngredients = async request => {
  let persistedIngredients;
  try {
    persistedIngredients = await db.Ingredient.findAll();
  } catch (error) {
    console.log(
      `Failed to retreive saved ingredients due to following error: ${error}`
    );
    return;
  }
  let ingredientToSave;
  if (persistedIngredients.length) {
    const currentIngredients = persistedIngredients.map(element => {
      return element.title.toLowerCase();
    });
    ingredientToSave = request.body.ingredients
      .filter(
        element => currentIngredients.indexOf(element.title.toLowerCase()) < 0
      )
      .map(element => {
        return {
          title: element.title.toLowerCase()
        };
      });
  } else {
    ingredientToSave = request.body.ingredients.map(element => {
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
      `failed to persist new ingredients due to following error: ${error}`
    );
    return;
  }
  return persistedIngredients;
};

/**
 * it persists recipe and ingredient relations
 * in recipeIngredients table i.e. what quantity
 * of what ingredient is needed for which recipe.
 * @param {request as received from client} request
 * @param {all ingredients currently saved} persistedIngredients
 * @param {recipe being saved currently} recipe
 */
const persistRecipeIngredients = async (
  request,
  persistedIngredients,
  recipe
) => {
  const recipeIngredientsToSave = request.body.ingredients.map(element => {
    return {
      ingredientQuantity: element.quantity,
      ingredQuantUnit: element.units,
      RecipeId: recipe.id,
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
      `failed to persist recipe ingredients due to following error: ${error}`
    );
    return false;
  }
};

module.exports = {
  createRecipe,
  persistAndFetchIngredients,
  persistRecipeIngredients
};