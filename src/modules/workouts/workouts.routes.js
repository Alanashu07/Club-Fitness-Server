import express from 'express';
import workoutController from './workouts.controller.js';
import { validateCreateMemberInput } from '../../validators/member.validator.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';

const router = express.Router();

router.use(authenticate);

//TEMPLATES
router.get('/templates', authorize('ADMIN', 'STAFF'), workoutController.getTemplates);
router.post('/templates', authorize('ADMIN', 'STAFF'), workoutController.saveTemplate);
router.get('/templates/:id', authorize('ADMIN', 'STAFF'), workoutController.getTemplateDetails);
router.delete('/templates/:id', authorize('ADMIN'), workoutController.deleteTemplate);

//EXERCISES
router.get('/exercises', authorize('ADMIN', 'STAFF'), workoutController.getAllExercises);
router.post('/exercises', authorize('ADMIN', 'STAFF'), workoutController.createExercise);
router.get('/exercises/:id', authorize('ADMIN', 'STAFF'), workoutController.getExerciseDetails);
router.patch('/exercises/:id', authorize('ADMIN'), workoutController.updateExercise);
router.post('/assign', authorize('ADMIN', 'STAFF'), workoutController.assignWorkout);

//WORKOUT PLANS
router.get('/plans', authorize('ADMIN', 'STAFF'), workoutController.getAllPlans);
router.post('/plans', authorize('ADMIN', 'STAFF'), workoutController.createWorkoutPlan);
router.get('/plans/:id', authorize('ADMIN', 'STAFF'), workoutController.getPlanDetails);
router.delete('/plans/:id', authorize('ADMIN', 'STAFF'), workoutController.deleteWorkoutPlan);

//USER WORKOUTS
router.get('/my', workoutController.getMyWorkouts);
router.get('/my-plan', workoutController.getWeek);
router.post('/toggle-exercise/:date/:exercise', workoutController.toggleExercise);

export default router;